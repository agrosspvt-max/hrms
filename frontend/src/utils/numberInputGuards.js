const selector = 'input[type="number"]';

export function installNumberInputGuards() {
  const preventArrowStep = (event) => {
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        event.target.matches?.(selector)) {
      // Let spreadsheet handlers move focus before suppressing native stepping.
      event.preventDefault();
    }
  };
  document.addEventListener('keydown', preventArrowStep);

  // Chromium and WebKit use the spinner removed in index.css. In other
  // engines, wheel stepping can be independent of spinner visibility.
  const needsWheelGuard = !CSS.supports('selector(input::-webkit-inner-spin-button)');
  const preventWheelStep = (event) => event.preventDefault();
  let focusedNumberInput;
  const unwatch = () => {
    focusedNumberInput?.removeEventListener('wheel', preventWheelStep);
    focusedNumberInput = undefined;
  };
  const watch = (event) => {
    unwatch();
    if (event.target.matches?.(selector)) {
      focusedNumberInput = event.target;
      focusedNumberInput.addEventListener('wheel', preventWheelStep, { passive: false });
    }
  };

  if (needsWheelGuard) {
    document.addEventListener('focusin', watch);
    document.addEventListener('focusout', unwatch);
    watch({ target: document.activeElement });
  }

  return () => {
    document.removeEventListener('keydown', preventArrowStep);
    if (needsWheelGuard) {
      document.removeEventListener('focusin', watch);
      document.removeEventListener('focusout', unwatch);
      unwatch();
    }
  };
}
