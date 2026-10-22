(function () {
  "use strict";

  const GENERIC_ERROR = "Something went wrong. Please try again.";
  const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";

  const FIRST_NAMES = [
    "maria", "james", "aisha", "daniel", "sofia", "liam",
    "priya", "noah", "elena", "omar", "hannah", "lucas"
  ];
  const LAST_NAMES = [
    "okafor", "schmidt", "nakamura", "garcia", "novak", "patel",
    "andersson", "kowalski", "mensah", "rossi", "haddad", "tanaka"
  ];

  const form = document.getElementById("sign-in-form");
  const emailInput = document.getElementById("email");
  const emailError = document.getElementById("email-error");
  const continueButton = document.getElementById("continue");
  const randomButton = document.getElementById("random-email");

  setYear();
  redirectIfSignedIn();

  randomButton.addEventListener("click", () => {
    emailInput.value = randomEmail();
    setError("");
    emailInput.focus();
  });

  emailInput.addEventListener("input", () => setError(""));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = emailInput.value.trim();
    if (!email) {
      setError("Enter your email.");
      emailInput.focus();
      return;
    }

    setBusy(true);

    let response;
    try {
      response = await fetch("/auth/sign-in", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email })
      });
    } catch (_) {
      setError(NETWORK_ERROR);
      setBusy(false);
      return;
    }

    if (response.status === 204) {
      window.location.href = "/account";
      return;
    }

    setError(await errorMessage(response));
    setBusy(false);
    emailInput.focus();
  });

  // The server already redirects signed-in users away from this page; this
  // covers a cached copy of the page.
  async function redirectIfSignedIn() {
    try {
      const response = await fetch("/api/me", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (response.ok) {
        window.location.replace("/account");
      }
    } catch (_) {
      // Offline or unreachable: the form still works once the server is back.
    }
  }

  async function errorMessage(response) {
    try {
      const body = await response.json();
      const message = body && body.error && body.error.message;
      if (typeof message === "string" && message) {
        return message;
      }
    } catch (_) {
      // Not a JSON envelope; fall through to a status-based message.
    }
    if (response.status === 429) {
      return "Too many sign-in attempts. Try again in a few minutes.";
    }
    return GENERIC_ERROR;
  }

  function setError(message) {
    emailError.textContent = message;
    if (message) {
      emailInput.setAttribute("aria-invalid", "true");
    } else {
      emailInput.removeAttribute("aria-invalid");
    }
  }

  function setBusy(busy) {
    continueButton.disabled = busy;
    randomButton.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
  }

  function randomEmail() {
    const digits = 1000 + Math.floor(Math.random() * 9000);
    return `${pick(FIRST_NAMES)}.${pick(LAST_NAMES)}.${digits}@example.com`;
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function setYear() {
    const year = document.getElementById("year");
    if (year) {
      year.textContent = String(new Date().getFullYear());
    }
  }
})();
