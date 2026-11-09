//! Owned child processes for authenticated application supervisors.
//!
//! Every wait and signal is serialized by the same mutex. A Unix PID (or
//! process-group ID) is used only while its owned child has not been reaped.
//! A new session is not a sandbox: descendants can escape with `setsid`.

use std::{collections::HashMap, io, path::PathBuf};

#[cfg(unix)]
mod output;

/// Explicit application launch configuration; no parent environment is
/// inherited.
pub struct OwnedChildOptions {
	pub application:          String,
	pub args:                 Vec<String>,
	pub cwd:                  PathBuf,
	pub env:                  HashMap<String, String>,
	pub output_path:          PathBuf,
	/// Rotation is enabled only when both optional fields are present.
	pub max_output_bytes:     Option<u64>,
	pub previous_output_path: Option<PathBuf>,
}

/// Cached terminal status remains available after the child has been reaped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnedChildStatus {
	pub running:   bool,
	pub exit_code: Option<i32>,
	pub signal:    Option<i32>,
}

#[cfg(unix)]
mod platform {
	use std::{
		collections::VecDeque,
		io::Write,
		os::{
			fd::OwnedFd,
			unix::{
				net::UnixStream,
				process::{CommandExt, ExitStatusExt},
			},
		},
		process::{Child, Command},
		sync::{
			Arc, LazyLock,
			mpsc::{self, Receiver, Sender},
		},
		thread,
		time::Duration,
	};

	use parking_lot::Mutex;

	use super::{
		OwnedChildOptions, OwnedChildStatus, io,
		output::{ChildOutput, OutputCapture},
	};

	const REAP_INTERVAL: Duration = Duration::from_millis(10);
	const MAX_PENDING_INPUT: usize = 64 * 1024;
	type SharedChild = Arc<Mutex<ChildState>>;

	struct ChildState {
		child:         Option<Child>,
		stdin:         Option<UnixStream>,
		input:         VecDeque<Vec<u8>>,
		input_offset:  usize,
		pending_bytes: usize,
		status:        OwnedChildStatus,
	}

	impl ChildState {
		fn poll(&mut self) -> io::Result<OwnedChildStatus> {
			if let Some(child) = self.child.as_mut()
				&& let Some(status) = child.try_wait()?
			{
				self.status = OwnedChildStatus {
					running:   false,
					exit_code: status.code(),
					signal:    status.signal(),
				};
				self.child = None;
				self.close_input();
			}
			Ok(self.status)
		}

		fn close_input(&mut self) {
			self.stdin = None;
			self.input.clear();
			self.input_offset = 0;
			self.pending_bytes = 0;
		}

		fn flush_input(&mut self) -> io::Result<()> {
			while let Some(front) = self.input.front() {
				let Some(stdin) = self.stdin.as_mut() else {
					return Err(io::Error::new(io::ErrorKind::BrokenPipe, "child stdin is closed"));
				};
				match stdin.write(&front[self.input_offset..]) {
					Ok(0) => {
						self.close_input();
						return Err(io::Error::new(
							io::ErrorKind::WriteZero,
							"child stdin accepted no bytes",
						));
					},
					Ok(written) => {
						self.input_offset += written;
						self.pending_bytes -= written;
						if self.input_offset == front.len() {
							self.input.pop_front();
							self.input_offset = 0;
						}
					},
					Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
					Err(error) => {
						self.close_input();
						return Err(error);
					},
				}
			}
			Ok(())
		}

		fn signal_with(
			&mut self,
			signal: i32,
			group: bool,
			send: impl FnOnce(i32, i32) -> io::Result<bool>,
		) -> io::Result<bool> {
			// In particular, do not use the cached PID after try_wait reaps it.
			if !self.poll()?.running {
				return Ok(false);
			}
			let child = self.child.as_ref().expect("running state owns a child");
			let pid = i32::try_from(child.id())
				.map_err(|_| io::Error::other("child PID does not fit a Unix pid_t"))?;
			send(if group { -pid } else { pid }, signal)
		}
	}

	/// Owns the native `Child`; neither PID adoption nor external reaping is
	/// used.
	pub struct OwnedChild {
		pid:    u32,
		state:  SharedChild,
		output: Option<OutputCapture>,
	}

	impl OwnedChild {
		pub fn spawn(options: OwnedChildOptions) -> io::Result<Self> {
			// Establish a fallible reaper before starting any child. Its Arc keeps
			// the child owned even after the JS wrapper is collected; Drop never
			// waits.
			let reaper = reaper()?;
			let output = ChildOutput::open(
				options.output_path,
				options.max_output_bytes,
				options.previous_output_path,
			)?;
			let (stdin_read, stdin_write) = UnixStream::pair()?;
			// UnixStream's write suppresses SIGPIPE without changing the host's
			// signal disposition. Only the parent end is nonblocking.
			stdin_write.set_nonblocking(true)?;
			let mut command = Command::new(options.application);
			command
				.args(options.args)
				.current_dir(options.cwd)
				.env_clear()
				.envs(options.env)
				.stdin(OwnedFd::from(stdin_read))
				.stdout(output.stdout)
				.stderr(output.stderr);
			// SAFETY: setsid is async-signal-safe and this closure neither
			// allocates nor touches parent locks between fork and exec.
			// Spawn propagates errno.
			unsafe {
				command.pre_exec(|| {
					if libc::setsid() == -1 {
						Err(io::Error::last_os_error())
					} else {
						Ok(())
					}
				});
			}
			let child = command.spawn()?;
			let pid = child.id();
			let state = Arc::new(Mutex::new(ChildState {
				child:         Some(child),
				stdin:         Some(stdin_write),
				input:         VecDeque::new(),
				input_offset:  0,
				pending_bytes: 0,
				status:        OwnedChildStatus { running: true, exit_code: None, signal: None },
			}));
			// The process-lifetime reaper has no panicking operations and retains
			// its receiver forever. A poisoned mutex cannot terminate it.
			reaper
				.send(Arc::clone(&state))
				.expect("owned child reaper remains alive");
			Ok(Self { pid, state, output: output.capture })
		}

		#[must_use]
		pub const fn pid(&self) -> u32 {
			self.pid
		}

		/// Terminal completion includes all pipe bytes queued when exit is
		/// observed, not EOF from possibly escaped descendants retaining an
		/// output writer.
		pub fn poll(&self) -> io::Result<OwnedChildStatus> {
			if let Some(output) = &self.output {
				output.drain()?;
			}
			let status = self.state.lock().poll()?;
			if !status.running
				&& let Some(output) = &self.output
				&& !output.finish()?
			{
				return Ok(OwnedChildStatus { running: true, exit_code: None, signal: None });
			}
			Ok(status)
		}

		/// Signal the owned leader, optionally its session's original group.
		/// Group membership is not descendant containment; escaped groups
		/// survive.
		pub fn signal(&self, signal: i32, group: bool) -> io::Result<bool> {
			self
				.state
				.lock()
				.signal_with(signal, group, |target, signal| {
					// SAFETY: the lifecycle mutex excludes every reap while kill
					// uses this owned, unreaped leader's PID (or its
					// original group ID).
					if unsafe { libc::kill(target, signal) } == 0 {
						return Ok(true);
					}
					let error = io::Error::last_os_error();
					if error.raw_os_error() == Some(libc::ESRCH) {
						Ok(false)
					} else {
						Err(error)
					}
				})
		}

		/// Enqueue UTF-8 stdin without blocking JS; at most 64 KiB may be
		/// pending.
		pub fn write(&self, data: &str) -> io::Result<()> {
			let mut state = self.state.lock();
			if !state.poll()?.running || state.stdin.is_none() {
				return Err(io::Error::new(io::ErrorKind::BrokenPipe, "child stdin is closed"));
			}
			state.flush_input()?;
			if data.len() > MAX_PENDING_INPUT - state.pending_bytes {
				return Err(io::Error::new(
					io::ErrorKind::WouldBlock,
					"child stdin queue exceeds 64 KiB",
				));
			}
			// Avoid copying inputs the nonblocking socket can accept immediately.
			let mut pending = data.as_bytes();
			if state.input.is_empty() {
				while !pending.is_empty() {
					match state
						.stdin
						.as_mut()
						.expect("open stdin checked above")
						.write(pending)
					{
						Ok(0) => {
							state.close_input();
							return Err(io::Error::new(
								io::ErrorKind::WriteZero,
								"child stdin accepted no bytes",
							));
						},
						Ok(count) => pending = &pending[count..],
						Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
						Err(error) if error.kind() == io::ErrorKind::Interrupted => {},
						Err(error) => {
							state.close_input();
							return Err(error);
						},
					}
				}
			}
			if !pending.is_empty() {
				state.pending_bytes += pending.len();
				state.input.push_back(pending.to_vec());
			}
			Ok(())
		}
	}

	impl Drop for OwnedChild {
		fn drop(&mut self) {
			// Closing stdin lets input-driven children finish, without killing a
			// long-lived application or blocking this thread on its eventual exit.
			self.state.lock().close_input();
		}
	}

	fn reaper() -> io::Result<&'static Sender<SharedChild>> {
		static REAPER: LazyLock<Result<Sender<SharedChild>, String>> = LazyLock::new(|| {
			let (sender, receiver) = mpsc::channel();
			thread::Builder::new()
				.name("omp-owned-child-reaper".into())
				.spawn(move || reap_children(receiver))
				.map(|_| sender)
				.map_err(|error| error.to_string())
		});
		REAPER
			.as_ref()
			.map_err(|error| io::Error::other(error.clone()))
	}

	fn reap_children(receiver: Receiver<SharedChild>) {
		let mut children: Vec<SharedChild> = Vec::new();
		loop {
			let incoming = if children.is_empty() {
				receiver.recv().ok()
			} else {
				receiver.recv_timeout(REAP_INTERVAL).ok()
			};
			if let Some(child) = incoming {
				children.push(child);
			}
			children.extend(receiver.try_iter());
			children.retain(|child| {
				let mut state = child.lock();
				// Errors fail closed for signals. Keep ownership and retry wait,
				// rather than dropping a possibly unreaped child on a transient
				// error.
				let running = state.poll().map_or(true, |status| status.running);
				if running {
					let _ = state.flush_input();
				}
				running
			});
		}
	}

	#[cfg(test)]
	mod tests {
		use std::{fs, sync::mpsc, time::Instant};

		use super::*;

		fn spawn(script: &str, directory: &std::path::Path) -> OwnedChild {
			OwnedChild::spawn(OwnedChildOptions {
				application:          "/bin/sh".into(),
				args:                 vec!["-c".into(), script.into()],
				cwd:                  directory.into(),
				env:                  std::collections::HashMap::new(),
				output_path:          directory.join("output"),
				max_output_bytes:     None,
				previous_output_path: None,
			})
			.unwrap()
		}

		fn exited(child: &OwnedChild) -> OwnedChildStatus {
			let deadline = Instant::now() + Duration::from_secs(5);
			loop {
				let status = child.poll().unwrap();
				if !status.running {
					return status;
				}
				assert!(Instant::now() < deadline, "owned child did not exit");
				thread::sleep(Duration::from_millis(1));
			}
		}

		#[test]
		fn explicit_environment_cwd_and_append_output() {
			let directory = tempfile::tempdir().unwrap();
			fs::write(directory.path().join("output"), "prefix\n").unwrap();
			let child = OwnedChild::spawn(OwnedChildOptions {
				application:          "/bin/sh".into(),
				args:                 vec![
					"-c".into(),
					"printf '%s\\n' \"$OWNED_VALUE\"; printf 'stderr\\n' >&2; /usr/bin/env; pwd; exit \
					 23"
					.into(),
				],
				cwd:                  directory.path().into(),
				env:                  std::collections::HashMap::from([(
					"OWNED_VALUE".into(),
					"explicit".into(),
				)]),
				output_path:          directory.path().join("output"),
				max_output_bytes:     None,
				previous_output_path: None,
			})
			.unwrap();
			assert_eq!(exited(&child), OwnedChildStatus {
				running:   false,
				exit_code: Some(23),
				signal:    None,
			});
			let output = fs::read_to_string(directory.path().join("output")).unwrap();
			assert!(output.starts_with("prefix\nexplicit\nstderr\n"));
			assert!(output.contains("OWNED_VALUE=explicit\n"));
			// A shell may synthesize PWD/SHLVL, but none of the parent's other
			// environment variables may reach the application.
			for (key, value) in std::env::vars() {
				if !matches!(key.as_str(), "OWNED_VALUE" | "PWD" | "OLDPWD" | "SHLVL" | "_")
					&& !value.is_empty()
				{
					assert!(!output.lines().any(|line| line == format!("{key}={value}")));
				}
			}
			assert!(output.contains(directory.path().to_str().unwrap()));
		}

		#[test]
		fn terminal_status_never_signals_reaped_pid_or_group() {
			let directory = tempfile::tempdir().unwrap();
			let child = spawn("exit 7", directory.path());
			let status = exited(&child);
			assert_eq!(status.exit_code, Some(7));
			for group in [false, true] {
				assert!(
					!child
						.state
						.lock()
						.signal_with(9, group, |_, _| panic!("signaled after reap"))
						.unwrap()
				);
				assert!(!child.signal(9, group).unwrap());
			}
			assert_eq!(child.poll().unwrap(), status);
			assert!(child.write("input").is_err());
		}

		#[test]
		fn signal_and_reap_share_one_lifecycle_lock() {
			let directory = tempfile::tempdir().unwrap();
			let child = spawn("read line; exit 17", directory.path());
			let state = Arc::clone(&child.state);
			let (entered_tx, entered_rx) = mpsc::channel();
			let (release_tx, release_rx) = mpsc::channel();
			let signaler = thread::spawn(move || {
				state
					.lock()
					.signal_with(libc::SIGKILL, false, |target, signal| {
						// SAFETY: this test callback is inside the lifecycle lock and
						// receives only the still-owned leader PID.
						assert_eq!(unsafe { libc::kill(target, signal) }, 0);
						entered_tx.send(()).unwrap();
						release_rx.recv().unwrap();
						Ok(true)
					})
					.unwrap()
			});
			entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
			assert!(child.state.try_lock().is_none(), "reap could interleave with signal");
			release_tx.send(()).unwrap();
			assert!(signaler.join().unwrap());
			assert_eq!(exited(&child).signal, Some(libc::SIGKILL));
		}

		#[test]
		fn group_signal_reports_signal_exit_and_does_not_repeat_after_reap() {
			let directory = tempfile::tempdir().unwrap();
			let child = spawn("read line", directory.path());
			assert!(child.signal(libc::SIGKILL, true).unwrap());
			assert_eq!(exited(&child), OwnedChildStatus {
				running:   false,
				exit_code: None,
				signal:    Some(libc::SIGKILL),
			});
			assert!(!child.signal(libc::SIGKILL, true).unwrap());
		}

		#[test]
		fn terminal_poll_flushes_and_rotates_merged_leader_output() {
			let directory = tempfile::tempdir().unwrap();
			let output = directory.path().join("output");
			let previous = directory.path().join("previous");
			let child = OwnedChild::spawn(OwnedChildOptions {
				application:          "/bin/sh".into(),
				args:                 vec![
					"-c".into(),
					"printf 'abcdefghijkl'; printf 'mnop' >&2; printf 'END'".into(),
				],
				cwd:                  directory.path().into(),
				env:                  std::collections::HashMap::new(),
				output_path:          output.clone(),
				max_output_bytes:     Some(8),
				previous_output_path: Some(previous.clone()),
			})
			.unwrap();
			assert_eq!(exited(&child).exit_code, Some(0));
			assert_eq!(fs::read(&previous).unwrap(), b"ijklmnop");
			assert_eq!(fs::read(&output).unwrap(), b"END");
		}

		#[test]
		fn input_is_bounded_and_drop_closes_stdin_then_background_reaps() {
			let directory = tempfile::tempdir().unwrap();
			let child = spawn("read line; exit 0", directory.path());
			assert_eq!(
				child
					.write(&"x".repeat(MAX_PENDING_INPUT + 1))
					.unwrap_err()
					.kind(),
				io::ErrorKind::WouldBlock
			);
			let state = Arc::clone(&child.state);
			let before = Instant::now();
			drop(child);
			assert!(before.elapsed() < Duration::from_secs(1));
			let deadline = Instant::now() + Duration::from_secs(5);
			// Do not call poll here: only the background reaper can complete it.
			while state.lock().child.is_some() {
				assert!(Instant::now() < deadline, "dropped child was not reaped");
				thread::sleep(Duration::from_millis(1));
			}
			assert!(!state.lock().status.running);
		}
	}
}

#[cfg(unix)]
pub use platform::OwnedChild;

/// Owned sessions/groups are not implemented safely on this platform.
#[cfg(not(unix))]
pub struct OwnedChild;

#[cfg(not(unix))]
impl OwnedChild {
	pub fn spawn(_options: OwnedChildOptions) -> io::Result<Self> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"OwnedChild requires Unix owned session/group support",
		))
	}

	#[must_use]
	pub const fn pid(&self) -> u32 {
		0
	}

	pub fn poll(&self) -> io::Result<OwnedChildStatus> {
		Err(io::Error::new(io::ErrorKind::Unsupported, "OwnedChild is unsupported on this platform"))
	}

	pub fn signal(&self, _signal: i32, _group: bool) -> io::Result<bool> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"OwnedChild signals are unsupported on this platform",
		))
	}

	pub fn write(&self, _data: &str) -> io::Result<()> {
		Err(io::Error::new(io::ErrorKind::Unsupported, "OwnedChild is unsupported on this platform"))
	}
}
