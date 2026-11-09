//! Thin N-API bindings for native-owned supervisor applications.

use std::collections::HashMap;

use napi::{
	Result,
	bindgen_prelude::{Either, Null},
};
use napi_derive::napi;
use pi_shell::owned_child::{self as core, OwnedChildOptions as CoreOptions};

/// Explicit application configuration. No supervisor environment is inherited.
#[napi(object, object_to_js = false)]
pub struct OwnedChildSpawnOptions {
	pub application:          String,
	pub args:                 Vec<String>,
	pub cwd:                  String,
	pub env:                  HashMap<String, String>,
	pub output_path:          String,
	/// Optional positive byte cap, paired with previousOutputPath.
	pub max_output_bytes:     Option<f64>,
	/// Previous rotated log path, paired with maxOutputBytes.
	pub previous_output_path: Option<String>,
}

/// Status is cached after native ownership has reaped the application.
#[napi(object)]
pub struct OwnedChildPollResult {
	pub running:   bool,
	#[napi(ts_type = "number | null")]
	pub exit_code: Either<i32, Null>,
	#[napi(ts_type = "number | null")]
	pub signal:    Either<i32, Null>,
}

/// Native-owned child in a fresh Unix session, not a descendant sandbox.
/// Unsupported platforms reject spawn rather than adopting numeric PIDs.
#[napi]
pub struct OwnedChild {
	inner: core::OwnedChild,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl OwnedChild {
	/// Spawn with explicit environment and append stdout/stderr to outputPath.
	#[napi]
	pub fn spawn(options: OwnedChildSpawnOptions) -> Result<OwnedChild> {
		let max_output_bytes = options
			.max_output_bytes
			.map(|value| {
				if !value.is_finite()
					|| value < 1.0
					|| value > 9_007_199_254_740_991.0
					|| value.fract() != 0.0
				{
					return Err(napi::Error::from_reason(
						"maxOutputBytes must be a positive safe integer",
					));
				}
				Ok(value as u64)
			})
			.transpose()?;
		let inner = core::OwnedChild::spawn(CoreOptions {
			application: options.application,
			args: options.args,
			cwd: options.cwd.into(),
			env: options.env,
			output_path: options.output_path.into(),
			max_output_bytes,
			previous_output_path: options.previous_output_path.map(Into::into),
		})
		.map_err(|error| napi::Error::from_reason(error.to_string()))?;
		Ok(Self { inner })
	}

	/// Operating-system PID; never usable to reconstruct ownership.
	#[napi(getter)]
	pub const fn pid(&self) -> u32 {
		self.inner.pid()
	}

	/// Poll and reap under the same lock used for all signals.
	/// Terminal completion waits for queued leader output, not descendant EOF.
	#[napi]
	pub fn poll(&self) -> Result<OwnedChildPollResult> {
		let status = self
			.inner
			.poll()
			.map_err(|error| napi::Error::from_reason(error.to_string()))?;
		Ok(OwnedChildPollResult {
			running:   status.running,
			exit_code: status.exit_code.map_or(Either::B(Null), Either::A),
			signal:    status.signal.map_or(Either::B(Null), Either::A),
		})
	}

	/// Signal only while the owned leader is unreaped. An optional group signal
	/// reaches the original group, not descendants that escaped that group.
	#[napi]
	pub fn signal(&self, signal: i32, group: Option<bool>) -> Result<bool> {
		self
			.inner
			.signal(signal, group.unwrap_or(false))
			.map_err(|error| napi::Error::from_reason(error.to_string()))
	}

	/// Queue UTF-8 stdin without blocking. Throws above 64 KiB pending input,
	/// or when the child has exited or its input has closed.
	#[napi]
	pub fn write(&self, data: String) -> Result<()> {
		self
			.inner
			.write(&data)
			.map_err(|error| napi::Error::from_reason(error.to_string()))
	}
}
