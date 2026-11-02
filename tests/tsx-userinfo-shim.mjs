// The managed Windows test host can reject os.userInfo() even though process
// execution and the temp directory are available. tsx prefers geteuid() when
// present, so provide a deterministic test-only identity on Windows.
if (process.platform === "win32" && typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", {
    value: () => 0,
    configurable: true,
  });
}
