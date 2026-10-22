(function () {
  "use strict";

  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const GENERIC_ERROR = "Something went wrong. Please try again.";
  const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";

  const KIND_LABELS = {
    passport: "Passport",
    id_card: "National ID card",
    driving_licence: "Driving licence"
  };

  const STATUS_LABELS = {
    received: "Received"
  };

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  const accountEmail = document.getElementById("account-email");
  const signOutButton = document.getElementById("sign-out");
  const pageNotice = document.getElementById("page-notice");

  const uploadForm = document.getElementById("upload-form");
  const kindSelect = document.getElementById("kind");
  const fileInput = document.getElementById("file");
  const uploadButton = document.getElementById("upload");
  const progressWrap = document.getElementById("upload-progress-wrap");
  const progressBar = document.getElementById("upload-progress");
  const progressLabel = document.getElementById("upload-percent");
  const uploadStatus = document.getElementById("upload-status");

  const documentsTitle = document.getElementById("documents-title");
  const documentsStatus = document.getElementById("documents-status");
  const documentList = document.getElementById("document-list");
  const rowTemplate = document.getElementById("document-row");

  init();

  async function init() {
    setYear();

    signOutButton.addEventListener("click", signOut);
    uploadForm.addEventListener("submit", onUploadSubmit);
    fileInput.addEventListener("change", () => setStatus(uploadStatus, ""));

    const signedIn = await loadAccount();
    if (signedIn) {
      await loadDocuments();
    }
  }

  // Account

  async function loadAccount() {
    let response;
    try {
      response = await request("GET", "/api/me");
    } catch (_) {
      showNotice(NETWORK_ERROR);
      return true;
    }

    if (response.status === 401) {
      redirectToSignIn();
      return false;
    }

    if (!response.ok) {
      showNotice(await errorMessage(response));
      return true;
    }

    const me = await readJson(response);
    if (me && typeof me.email === "string") {
      accountEmail.textContent = me.email;
    }
    return true;
  }

  async function signOut() {
    signOutButton.disabled = true;

    let response;
    try {
      response = await request("POST", "/auth/sign-out");
    } catch (_) {
      showNotice(NETWORK_ERROR);
      signOutButton.disabled = false;
      return;
    }

    if (response.status === 204 || response.status === 401) {
      window.location.href = "/";
      return;
    }

    showNotice(await errorMessage(response));
    signOutButton.disabled = false;
  }

  // Documents

  async function loadDocuments() {
    setStatus(documentsStatus, "Loading…", "muted");

    let response;
    try {
      response = await request("GET", "/api/documents");
    } catch (_) {
      setStatus(documentsStatus, NETWORK_ERROR, "error");
      return;
    }

    if (response.status === 401) {
      redirectToSignIn();
      return;
    }

    if (!response.ok) {
      setStatus(documentsStatus, await errorMessage(response), "error");
      return;
    }

    const body = await readJson(response);
    const documents = body && Array.isArray(body.documents) ? body.documents : [];
    renderDocuments(documents);
  }

  function renderDocuments(documents) {
    documentList.textContent = "";
    for (const doc of documents) {
      documentList.appendChild(documentRow(doc));
    }
    refreshEmptyState();
  }

  function documentRow(doc) {
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".document");
    const fileUrl = `${documentUrl(doc.id)}/file`;

    row.dataset.id = doc.id;
    row.querySelector(".document-thumb").src = fileUrl;
    row.querySelector(".document-kind").textContent = KIND_LABELS[doc.kind] || doc.kind;
    row.querySelector(".document-status").textContent = STATUS_LABELS[doc.status] || doc.status;
    row.querySelector(".document-name").textContent = doc.fileName;
    row.querySelector(".document-size").textContent = formatSize(doc.size);

    const date = row.querySelector(".document-date");
    date.dateTime = doc.createdAt;
    date.textContent = formatDate(doc.createdAt);

    const openLink = row.querySelector(".document-open");
    openLink.href = fileUrl;
    openLink.setAttribute("aria-label", `Open ${doc.fileName}`);

    const deleteButton = row.querySelector(".document-delete");
    deleteButton.setAttribute("aria-label", `Delete ${doc.fileName}`);
    deleteButton.addEventListener("click", () => deleteDocument(doc, row, deleteButton));

    return row;
  }

  async function deleteDocument(doc, row, button) {
    if (!window.confirm(`Delete "${doc.fileName}"? This cannot be undone.`)) {
      return;
    }

    button.disabled = true;

    let response;
    try {
      response = await request("DELETE", documentUrl(doc.id));
    } catch (_) {
      setStatus(documentsStatus, NETWORK_ERROR, "error");
      button.disabled = false;
      return;
    }

    if (response.status === 401) {
      redirectToSignIn();
      return;
    }

    if (response.status !== 204) {
      setStatus(documentsStatus, await errorMessage(response), "error");
      button.disabled = false;
      return;
    }

    row.remove();
    documentsTitle.focus();
    refreshEmptyState(`Deleted ${doc.fileName}.`);
  }

  function refreshEmptyState(message) {
    if (documentList.children.length === 0) {
      setStatus(documentsStatus, "No documents yet.", "muted");
    } else {
      setStatus(documentsStatus, message || "", "success");
    }
  }

  // Upload

  function onUploadSubmit(event) {
    event.preventDefault();

    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      setStatus(uploadStatus, "Choose an image to upload.", "error");
      fileInput.focus();
      return;
    }
    if (file.size === 0) {
      setStatus(uploadStatus, "That file is empty.", "error");
      fileInput.focus();
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setStatus(uploadStatus, `That file is ${formatSize(file.size)}. The limit is 10 MB.`, "error");
      fileInput.focus();
      return;
    }

    upload(kindSelect.value, file);
  }

  function upload(kind, file) {
    const body = new FormData();
    body.append("kind", kind);
    body.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");
    xhr.responseType = "json";
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }
      setProgress(event.loaded / event.total);
      if (event.loaded >= event.total) {
        setStatus(uploadStatus, "Processing…", "muted");
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status === 201) {
        const uploaded = xhr.response && xhr.response.document;
        const name = uploaded && uploaded.fileName ? uploaded.fileName : file.name;
        fileInput.value = "";
        setStatus(uploadStatus, `Uploaded ${name}.`, "success");
        loadDocuments();
        return;
      }
      if (xhr.status === 401) {
        redirectToSignIn();
        return;
      }
      setStatus(uploadStatus, xhrErrorMessage(xhr), "error");
    });

    xhr.addEventListener("error", () => {
      setStatus(uploadStatus, NETWORK_ERROR, "error");
    });

    xhr.addEventListener("loadend", () => {
      setUploadBusy(false);
      progressWrap.hidden = true;
    });

    setUploadBusy(true);
    setProgress(0);
    setStatus(uploadStatus, "Uploading…", "muted");
    xhr.send(body);
  }

  function setProgress(fraction) {
    const percent = Math.min(100, Math.round(fraction * 100));
    progressWrap.hidden = false;
    progressBar.value = percent;
    progressLabel.textContent = `${percent}%`;
  }

  function setUploadBusy(busy) {
    uploadButton.disabled = busy;
    kindSelect.disabled = busy;
    fileInput.disabled = busy;
    uploadForm.setAttribute("aria-busy", String(busy));
  }

  function xhrErrorMessage(xhr) {
    const body = xhr.response;
    const message = body && body.error && body.error.message;
    if (typeof message === "string" && message) {
      return message;
    }
    if (xhr.status === 413) {
      return "That file is too large. The limit is 10 MB.";
    }
    return GENERIC_ERROR;
  }

  // HTTP helpers

  function request(method, url) {
    return fetch(url, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  async function errorMessage(response) {
    const body = await readJson(response);
    const message = body && body.error && body.error.message;
    if (typeof message === "string" && message) {
      return message;
    }
    return GENERIC_ERROR;
  }

  function documentUrl(id) {
    return `/api/documents/${encodeURIComponent(id)}`;
  }

  function redirectToSignIn() {
    window.location.replace("/");
  }

  // Presentation helpers

  function setStatus(element, message, tone) {
    element.textContent = message;
    element.classList.remove("status-muted", "status-error", "status-success");
    if (message && tone) {
      element.classList.add(`status-${tone}`);
    }
  }

  function showNotice(message) {
    pageNotice.textContent = message;
    pageNotice.hidden = !message;
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "";
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
  }

  function setYear() {
    const year = document.getElementById("year");
    if (year) {
      year.textContent = String(new Date().getFullYear());
    }
  }
})();
