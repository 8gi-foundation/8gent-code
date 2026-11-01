// Inline theme bootstrap to prevent flash-of-wrong-theme. Runs before React hydrates.
(function () {
	let theme = null;
	try {
		theme = localStorage.getItem("8gent-debugger-theme");
		if (theme === "dark") document.documentElement.classList.add("dark");
		else if (theme === "light") document.documentElement.classList.remove("dark");
		else if (window.matchMedia("(prefers-color-scheme: dark)").matches)
			document.documentElement.classList.add("dark");
	} catch (e) {
		// localStorage blocked; fall through to system preference handled by React
	}
})();
