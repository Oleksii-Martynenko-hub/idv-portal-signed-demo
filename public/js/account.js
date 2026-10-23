(function () {
  "use strict";

  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const GENERIC_ERROR = "Something went wrong. Please try again.";
  const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";

  // Open links expire about a minute after they are issued. Fetch fresh ones a
  // little before the earliest expiry, but never poll faster than the minimum.
  // A failed fetch is tried again after the retry delay, or sooner when the
  // links would lapse first.
  const LINK_REFRESH_LEAD_MS = 10 * 1000;
  const LINK_REFRESH_MIN_DELAY_MS = 5 * 1000;
  const LINK_REFRESH_RETRY_MS = 30 * 1000;

  const KIND_LABELS = {
    passport: "Passport",
    id_card: "National ID card",
    driving_licence: "Driving licence"
  };

  const STATUS_LABELS = {
    received: "Received",
    rejected: "Rejected"
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

  let linkRefreshTimer = 0;
  let linkRefreshDueAt = 0;
  let linkExpiresAt = 0;
  let linkRefreshWaiting = false;
  let linkRefreshGeneration = 0;

  init();

  async function init() {
    setYear();

    signOutButton.addEventListener("click", signOut);
    uploadForm.addEventListener("submit", onUploadSubmit);
    fileInput.addEventListener("change", () => setStatus(uploadStatus, ""));
    document.addEventListener("visibilitychange", refreshIfOverdue);
    // A laptop can wake without any visibility change.
    window.addEventListener("focus", refreshIfOverdue);
    window.addEventListener("pageshow", refreshIfOverdue);
    // The network often comes back only after those have fired.
    window.addEventListener("online", refreshOnReconnect);

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
      stopLinkRefresh();
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
    scheduleLinkRefresh(documents, serverTime(response));
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
    const thumb = row.querySelector(".document-thumb");
    const placeholder = row.querySelector(".document-placeholder");
    const status = row.querySelector(".document-status");
    const openLink = row.querySelector(".document-open");

    row.dataset.id = doc.id;
    row.querySelector(".document-kind").textContent = KIND_LABELS[doc.kind] || doc.kind;
    status.textContent = STATUS_LABELS[doc.status] || doc.status;
    row.querySelector(".document-name").textContent = doc.fileName;
    row.querySelector(".document-size").textContent = formatSize(doc.size);

    const date = row.querySelector(".document-date");
    date.dateTime = doc.createdAt;
    date.textContent = formatDate(doc.createdAt);

    if (doc.status === "rejected") {
      status.classList.add("badge-danger");
      if (typeof doc.rejectionReason === "string" && doc.rejectionReason) {
        const reason = row.querySelector(".document-reason");
        reason.textContent = doc.rejectionReason;
        reason.hidden = false;
      }
    }

    if (doc.status === "received" && hasLink(doc)) {
      placeholder.remove();
      thumb.src = doc.url;
      openLink.href = doc.url;
      openLink.setAttribute("aria-label", `Open ${doc.fileName}`);
    } else {
      // Nothing to show or open: the file was rejected or has no link.
      thumb.remove();
      openLink.remove();
      placeholder.hidden = false;
    }

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

  function hasLink(doc) {
    return typeof doc.url === "string" && doc.url !== "";
  }

  // Open links

  function scheduleLinkRefresh(documents, serverNow) {
    stopLinkRefresh();

    let earliest = Infinity;
    for (const doc of documents) {
      const expiresAt = Date.parse(doc.urlExpiresAt);
      if (hasLink(doc) && expiresAt < earliest) {
        earliest = expiresAt;
      }
    }
    if (earliest === Infinity) {
      return;
    }

    // Kept on the device clock, for the retry after a failed refresh.
    linkExpiresAt = Date.now() + (earliest - serverNow);
    startLinkRefreshTimer(earliest - LINK_REFRESH_LEAD_MS - serverNow);
  }

  // Timers can stall while the device sleeps, but Date.now() keeps counting.
  // It is compared only with itself, so a skewed device clock does not matter.
  function startLinkRefreshTimer(delay) {
    const wait = Math.max(delay, LINK_REFRESH_MIN_DELAY_MS);
    linkRefreshDueAt = Date.now() + wait;
    linkRefreshTimer = window.setTimeout(onLinkRefreshDue, wait);
  }

  // Also discards a refresh in flight, so its links never land on newer rows.
  function stopLinkRefresh() {
    window.clearTimeout(linkRefreshTimer);
    linkRefreshTimer = 0;
    linkRefreshDueAt = 0;
    linkExpiresAt = 0;
    linkRefreshWaiting = false;
    linkRefreshGeneration += 1;
  }

  function onLinkRefreshDue() {
    linkRefreshTimer = 0;
    if (document.hidden) {
      linkRefreshWaiting = true;
      return;
    }
    refreshLinks();
  }

  // A refresh in flight has neither a timer nor a wait pending, so this never
  // starts a second one.
  function refreshIfOverdue() {
    if (document.hidden) {
      return;
    }
    if (linkRefreshWaiting) {
      linkRefreshWaiting = false;
      refreshLinks();
      return;
    }
    if (linkRefreshTimer !== 0 && Date.now() >= linkRefreshDueAt) {
      window.clearTimeout(linkRefreshTimer);
      linkRefreshTimer = 0;
      refreshLinks();
    }
  }

  // After a wake the first refresh can fail before the network is back, and a
  // failed refresh then waits for its retry. Fetch as soon as the connection
  // returns instead. A refresh in flight has no timer pending, and one waiting
  // for the page to show is left to refreshIfOverdue.
  function refreshOnReconnect() {
    if (document.hidden || linkRefreshTimer === 0) {
      return;
    }
    window.clearTimeout(linkRefreshTimer);
    linkRefreshTimer = 0;
    refreshLinks();
  }

  // Updates links in place: re-rendering the list would move focus and reload
  // every thumbnail.
  async function refreshLinks() {
    const generation = linkRefreshGeneration;

    let response;
    try {
      response = await request("GET", "/api/documents");
    } catch (_) {
      response = null;
    }
    const body = response && response.ok ? await readJson(response) : null;

    if (generation !== linkRefreshGeneration) {
      return;
    }

    // Failures stay quiet. A signed-out session is left to the next action.
    if (!body || !Array.isArray(body.documents)) {
      if (!response || response.status !== 401) {
        // Never later than the refresh was due. Links within the lead time, or
        // already expired after a wake, get the minimum delay.
        const untilDue = linkExpiresAt - LINK_REFRESH_LEAD_MS - Date.now();
        startLinkRefreshTimer(Math.min(untilDue, LINK_REFRESH_RETRY_MS));
      }
      return;
    }

    const rows = new Map();
    for (const row of documentList.children) {
      rows.set(row.dataset.id, row);
    }
    const updated = body.documents.filter((doc) => updateRowLinks(rows.get(doc.id), doc));
    scheduleLinkRefresh(updated, serverTime(response));
  }

  function updateRowLinks(row, doc) {
    const openLink = row && row.querySelector(".document-open");
    if (!openLink || !hasLink(doc)) {
      return false;
    }
    openLink.href = doc.url;

    // S3 checks expiry only when a request starts, so a thumbnail that already
    // has image data keeps its link.
    const thumb = row.querySelector(".document-thumb");
    if (thumb && thumb.naturalWidth === 0) {
      thumb.src = doc.url;
    }
    return true;
  }

  // Link expiry times come from the server clock. Measuring against it keeps a
  // skewed device clock from refreshing too late or too often.
  function serverTime(response) {
    const time = Date.parse(response.headers.get("Date") || "");
    return Number.isNaN(time) ? Date.now() : time;
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
    // The type is signed into the upload link, so it must be one the server accepts.
    if (!ALLOWED_TYPES.includes(file.type)) {
      setStatus(uploadStatus, "Upload a JPEG, PNG or WebP image.", "error");
      fileInput.focus();
      return;
    }
    // The checksum needs WebCrypto, which browsers offer only on secure pages.
    if (!window.crypto || !window.crypto.subtle) {
      setStatus(uploadStatus, "Uploads need a secure (HTTPS) connection.", "error");
      return;
    }

    upload(kindSelect.value, file);
  }

  async function upload(kind, file) {
    setUploadBusy(true);
    setProgress(0);
    setStatus(uploadStatus, "Uploading…", "muted");

    try {
      await sendFile(kind, file);
    } catch (_) {
      setStatus(uploadStatus, GENERIC_ERROR, "error");
    } finally {
      setUploadBusy(false);
      progressWrap.hidden = true;
    }
  }

  // The server signs a short-lived link, the file goes straight to storage,
  // and the server checks it before it joins the list.
  async function sendFile(kind, file) {
    let checksum;
    try {
      checksum = await sha256Base64(file);
    } catch (_) {
      setStatus(uploadStatus, "That file could not be read. Choose it again.", "error");
      return;
    }

    const signedUpload = await createUpload(kind, file, checksum);
    if (!signedUpload) {
      return;
    }

    const status = await putFile(signedUpload, file);
    if (status !== 200) {
      setStatus(uploadStatus, putErrorMessage(status), "error");
      await cancelUpload(signedUpload);
      return;
    }

    setProgress(1);
    setStatus(uploadStatus, "Processing…", "muted");
    await completeUpload(signedUpload, file);
  }

  // Returns the signed upload, or null once the reason is shown.
  async function createUpload(kind, file, checksum) {
    let response;
    try {
      response = await request("POST", "/api/uploads", {
        kind,
        fileName: file.name,
        size: file.size,
        contentType: file.type,
        checksumSha256: checksum
      });
    } catch (_) {
      setStatus(uploadStatus, NETWORK_ERROR, "error");
      return null;
    }

    if (response.status === 401) {
      redirectToSignIn();
      return null;
    }

    if (!response.ok) {
      setStatus(uploadStatus, await errorMessage(response), "error");
      return null;
    }

    const body = await readJson(response);
    const signedUpload = body && body.upload;
    if (!isSignedUpload(signedUpload)) {
      setStatus(uploadStatus, GENERIC_ERROR, "error");
      return null;
    }
    return signedUpload;
  }

  // Resolves with the HTTP status; network, CORS and abort failures give 0.
  function putFile(signedUpload, file) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signedUpload.url);

      // Exactly the signed headers, nothing more. Cache-Control is among them
      // because browsers add their own next to If-None-Match otherwise.
      for (const [name, value] of Object.entries(signedUpload.headers)) {
        xhr.setRequestHeader(name, value);
      }

      xhr.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) {
          return;
        }
        setProgress(event.loaded / event.total);
        if (event.loaded >= event.total) {
          setStatus(uploadStatus, "Processing…", "muted");
        }
      });

      xhr.addEventListener("loadend", () => resolve(xhr.status));

      // The browser sets Content-Length from the file; it matches the signed size.
      xhr.send(file);
    });
  }

  function putErrorMessage(status) {
    if (status === 0) {
      return NETWORK_ERROR;
    }
    if (status === 403) {
      return "The upload was not accepted. Please try again.";
    }
    if (status === 412) {
      return "This upload was already used. Please try again.";
    }
    return GENERIC_ERROR;
  }

  // A pending upload counts toward the document cap until it expires, so give
  // the slot back once a PUT or a completion fails. Best effort, and harmless
  // when the upload is already gone or a completion still holds it (404, 409).
  // Never rejects. Callers wait for it, so the form is free again only once the
  // slot is back and a retry cannot hit the cap.
  function cancelUpload(signedUpload) {
    return request("DELETE", uploadUrl(signedUpload.id)).catch(() => {});
  }

  async function completeUpload(signedUpload, file) {
    let response;
    try {
      response = await request("POST", `${uploadUrl(signedUpload.id)}/complete`);
    } catch (_) {
      setStatus(uploadStatus, NETWORK_ERROR, "error");
      // The server may have finished the upload and only the response was lost.
      // The cancel then changes nothing and the reload lists the file.
      await cancelUpload(signedUpload);
      loadDocuments();
      return;
    }

    if (response.status === 401) {
      redirectToSignIn();
      return;
    }

    if (response.status === 201) {
      const body = await readJson(response);
      const uploaded = body && body.document;
      const name = uploaded && uploaded.fileName ? uploaded.fileName : file.name;
      fileInput.value = "";
      setStatus(uploadStatus, `Uploaded ${name}.`, "success");
      loadDocuments();
      return;
    }

    setStatus(uploadStatus, await errorMessage(response), "error");
    // A rejected file is kept on record and listed with the reason. Any other
    // failure can leave the upload pending.
    if (response.status === 422) {
      loadDocuments();
      return;
    }
    await cancelUpload(signedUpload);
  }

  // S3 refuses the upload if the bytes it receives do not match this digest.
  async function sha256Base64(file) {
    const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    let binary = "";
    for (const byte of new Uint8Array(digest)) {
      binary += String.fromCharCode(byte);
    }
    return window.btoa(binary);
  }

  function isSignedUpload(value) {
    if (!value || typeof value.id !== "string" || typeof value.url !== "string") {
      return false;
    }
    const headers = value.headers;
    return Boolean(headers) && typeof headers === "object" &&
      Object.values(headers).every((header) => typeof header === "string");
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

  // HTTP helpers

  function request(method, url, body) {
    const init = {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(url, init);
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

  function uploadUrl(id) {
    return `/api/uploads/${encodeURIComponent(id)}`;
  }

  function redirectToSignIn() {
    stopLinkRefresh();
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
