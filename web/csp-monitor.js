(() => {
  const violations = [];
  const runtimeErrors = [];
  const formatError = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  Object.defineProperty(window, "__reviewSecurityPolicyViolations", {
    value: violations,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(window, "__reviewRuntimeErrors", {
    value: runtimeErrors,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const originalConsoleError = console.error;
  console.error = (...args) => {
    runtimeErrors.push({ type: "console.error", message: args.map(formatError).join(" ") });
    originalConsoleError.apply(console, args);
  };
  window.addEventListener("error", (event) => {
    runtimeErrors.push({ type: "window.error", message: formatError(event.error || event.message) });
  });
  window.addEventListener("unhandledrejection", (event) => {
    runtimeErrors.push({ type: "unhandledrejection", message: formatError(event.reason) });
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push({
      violatedDirective: event.violatedDirective,
      effectiveDirective: event.effectiveDirective,
      blockedURI: event.blockedURI,
      sourceFile: event.sourceFile,
      lineNumber: event.lineNumber,
      columnNumber: event.columnNumber,
    });
  });
})();
