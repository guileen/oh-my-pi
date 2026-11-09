//! Native-owned merged output pipe and bounded, two-file append rotation.

use std::{
	fs::{self, File, OpenOptions},
	io::{self, PipeReader, Read, Write},
	os::{fd::AsRawFd, unix::fs::MetadataExt},
	path::PathBuf,
	process::Stdio,
	sync::{
		Arc, LazyLock,
		mpsc::{self, Receiver, Sender},
	},
	thread,
	time::Duration,
};

use parking_lot::Mutex;

const DRAIN_BYTES: usize = 64 * 1024;
const DRAIN_INTERVAL: Duration = Duration::from_millis(10);

type SharedOutput = Arc<Mutex<OutputState>>;

pub(super) struct ChildOutput {
	pub stdout:  Stdio,
	pub stderr:  Stdio,
	pub capture: Option<OutputCapture>,
}

pub(super) struct OutputCapture(SharedOutput);

impl OutputCapture {
	pub fn drain(&self) -> io::Result<()> {
		self.0.lock().drain()
	}

	pub fn finish(&self) -> io::Result<bool> {
		let mut state = self.0.lock();
		if state.pending_terminal.is_none() {
			let mut pending: libc::c_int = 0;
			if let Some(reader) = state.reader.as_ref() {
				// SAFETY: reader owns a live pipe FD; FIONREAD writes one c_int
				// to `pending`. Snapshot after wait includes every leader write.
				if unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD, &mut pending) } == -1 {
					return Err(io::Error::last_os_error());
				}
			}
			state.pending_terminal = Some(usize::try_from(pending).unwrap_or(0));
		}
		state.drain()?;
		Ok(state.pending_terminal == Some(0))
	}
}

impl ChildOutput {
	pub fn open(
		path: PathBuf,
		max_bytes: Option<u64>,
		previous: Option<PathBuf>,
	) -> io::Result<Self> {
		match (max_bytes, previous) {
			(None, None) => {
				let file = OpenOptions::new().create(true).append(true).open(path)?;
				Ok(Self { stderr: file.try_clone()?.into(), stdout: file.into(), capture: None })
			},
			(Some(max), Some(previous)) if max > 0 => {
				// Initialize the fallible worker before any application is spawned.
				let sender = output_worker()?;
				let sink = RotatingSink::open(path, previous, max)?;
				let (reader, writer) = io::pipe()?;
				crate::shell::set_nonblocking(&reader)?;
				let stderr = writer.try_clone()?.into();
				let state = Arc::new(Mutex::new(OutputState {
					reader: Some(reader),
					sink,
					error: None,
					pending_terminal: None,
				}));
				sender
					.send(Arc::clone(&state))
					.expect("owned output worker remains alive");
				Ok(Self { stdout: writer.into(), stderr, capture: Some(OutputCapture(state)) })
			},
			_ => Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"maxOutputBytes and previousOutputPath must be specified together with a positive \
				 limit",
			)),
		}
	}
}

struct RotatingSink {
	file:     Option<File>,
	path:     PathBuf,
	previous: PathBuf,
	max:      u64,
	bytes:    u64,
}

impl RotatingSink {
	fn open(path: PathBuf, previous: PathBuf, max: u64) -> io::Result<Self> {
		let file = OpenOptions::new().create(true).append(true).open(&path)?;
		let metadata = file.metadata()?;
		match fs::metadata(&previous) {
			Ok(old) => {
				// Reject aliases (including hard links), not merely equal strings.
				if old.dev() == metadata.dev() && old.ino() == metadata.ino() {
					return Err(io::Error::new(
						io::ErrorKind::InvalidInput,
						"output and previous output must be distinct files",
					));
				}
				if old.len() > max {
					OpenOptions::new()
						.write(true)
						.open(&previous)?
						.set_len(max)?;
				}
			},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error),
		}
		// Adopt existing append files without allowing an old oversized file to
		// violate the new bound. No child ever owns these file descriptors.
		let bytes = metadata.len().min(max);
		if metadata.len() > max {
			file.set_len(max)?;
		}
		Ok(Self { file: Some(file), path, previous, max, bytes })
	}

	fn rotate(&mut self) -> io::Result<()> {
		self.file = None;
		fs::rename(&self.path, &self.previous)?;
		self.file = Some(
			OpenOptions::new()
				.create_new(true)
				.append(true)
				.open(&self.path)?,
		);
		self.bytes = 0;
		Ok(())
	}

	fn append(&mut self, mut data: &[u8]) -> io::Result<()> {
		while !data.is_empty() {
			if self.bytes == self.max {
				self.rotate()?;
			}
			let remaining = usize::try_from(self.max - self.bytes).unwrap_or(usize::MAX);
			let count = data.len().min(remaining);
			self
				.file
				.as_mut()
				.ok_or_else(|| io::Error::other("output sink is closed"))?
				.write_all(&data[..count])?;
			self.bytes += count as u64;
			data = &data[count..];
		}
		Ok(())
	}
}

struct OutputState {
	reader:           Option<PipeReader>,
	sink:             RotatingSink,
	error:            Option<(io::ErrorKind, String)>,
	pending_terminal: Option<usize>,
}

impl OutputState {
	fn drain(&mut self) -> io::Result<()> {
		if let Some((kind, message)) = &self.error {
			return Err(io::Error::new(*kind, message.clone()));
		}
		let result = self.drain_chunk();
		// Freeze the leader's completed log boundary. Descendants retaining a
		// writer do not extend completion indefinitely or overwrite its tail.
		if self.pending_terminal == Some(0) {
			self.reader = None;
		}
		if let Err(error) = &result {
			// Fail visibly and close the pipe, rather than silently discard logs
			// or leave a child permanently blocked behind a failed output sink.
			self.error = Some((error.kind(), error.to_string()));
			self.reader = None;
		}
		result
	}

	fn drain_chunk(&mut self) -> io::Result<()> {
		let mut buffer = [0u8; 8192];
		let mut drained = 0;
		let limit = DRAIN_BYTES.min(self.pending_terminal.unwrap_or(DRAIN_BYTES));
		while drained < limit {
			let Some(reader) = self.reader.as_mut() else {
				break;
			};
			let count = (limit - drained).min(buffer.len());
			match reader.read(&mut buffer[..count]) {
				Ok(0) => {
					self.reader = None;
					break;
				},
				Ok(count) => {
					self.sink.append(&buffer[..count])?;
					drained += count;
					if let Some(pending) = self.pending_terminal.as_mut() {
						*pending = pending.saturating_sub(count);
					}
				},
				Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
				Err(error) => return Err(error),
			}
		}
		Ok(())
	}
}

fn output_worker() -> io::Result<&'static Sender<SharedOutput>> {
	static WORKER: LazyLock<Result<Sender<SharedOutput>, String>> = LazyLock::new(|| {
		let (sender, receiver) = mpsc::channel();
		thread::Builder::new()
			.name("omp-owned-output".into())
			.spawn(move || drain_outputs(receiver))
			.map(|_| sender)
			.map_err(|error| error.to_string())
	});
	WORKER
		.as_ref()
		.map_err(|error| io::Error::other(error.clone()))
}

fn drain_outputs(receiver: Receiver<SharedOutput>) {
	let mut outputs: Vec<SharedOutput> = Vec::new();
	loop {
		let incoming = if outputs.is_empty() {
			receiver.recv().ok()
		} else {
			receiver.recv_timeout(DRAIN_INTERVAL).ok()
		};
		if let Some(output) = incoming {
			outputs.push(output);
		}
		outputs.extend(receiver.try_iter());
		outputs.retain(|output| {
			let mut state = output.lock();
			let _ = state.drain();
			state.reader.is_some()
		});
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rotation_caps_both_files_and_preserves_append_order() {
		let directory = tempfile::tempdir().unwrap();
		let path = directory.path().join("output");
		let previous = directory.path().join("previous");
		fs::write(&path, "abcd").unwrap();
		fs::write(&previous, "older-log-too-long").unwrap();
		let mut sink = RotatingSink::open(path.clone(), previous.clone(), 4).unwrap();
		assert_eq!(fs::metadata(&previous).unwrap().len(), 4);
		sink.append(b"efghijklmn").unwrap();
		assert_eq!(fs::read(&previous).unwrap(), b"ijkl");
		assert_eq!(fs::read(&path).unwrap(), b"mn");
		sink.append(b"op").unwrap();
		assert_eq!(fs::read(&path).unwrap(), b"mnop");
		assert_eq!(fs::read(&previous).unwrap(), b"ijkl");
	}

	#[test]
	fn rejects_output_aliases_before_rotation() {
		let directory = tempfile::tempdir().unwrap();
		let path = directory.path().join("output");
		fs::write(&path, "original").unwrap();
		assert!(RotatingSink::open(path.clone(), path.clone(), 4).is_err());
		let link = directory.path().join("link");
		fs::hard_link(&path, &link).unwrap();
		assert!(RotatingSink::open(path.clone(), link, 4).is_err());
		assert_eq!(fs::read(&path).unwrap(), b"original");
	}

	#[test]
	fn terminal_snapshot_finishes_without_waiting_for_inherited_writer_eof() {
		let directory = tempfile::tempdir().unwrap();
		let path = directory.path().join("output");
		let previous = directory.path().join("previous");
		let sink = RotatingSink::open(path.clone(), previous.clone(), 4).unwrap();
		let (reader, mut writer) = io::pipe().unwrap();
		crate::shell::set_nonblocking(&reader).unwrap();
		writer.write_all(b"abcdef").unwrap();
		let capture = OutputCapture(Arc::new(Mutex::new(OutputState {
			reader: Some(reader),
			sink,
			error: None,
			pending_terminal: None,
		})));
		// Writer intentionally remains open: completion snapshots queued leader
		// bytes instead of waiting for descendants to close inherited handles.
		assert!(capture.finish().unwrap());
		assert_eq!(fs::read(&previous).unwrap(), b"abcd");
		assert_eq!(fs::read(&path).unwrap(), b"ef");
		assert!(capture.0.lock().reader.is_none());
		assert!(capture.finish().unwrap());
		drop(writer);
	}
}
