(() => {
  const violations = [];
  Object.defineProperty(window, "__reviewSecurityPolicyViolations", {
    value: violations,
    enumerable: false,
    configurable: false,
    writable: false,
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
