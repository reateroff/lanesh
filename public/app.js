const MAX_SIZE = 5 * 1024 * 1024;
const dropzone = document.querySelector("#dropzone");
const input = document.querySelector("#fileInput");
const selectButton = document.querySelector("#selectButton");
const uploadTitle = document.querySelector("#uploadTitle");
const fileMeta = document.querySelector("#fileMeta");
const errorBox = document.querySelector("#error");
const result = document.querySelector("#result");
const preview = document.querySelector("#preview");
const resultUrl = document.querySelector("#resultUrl");
const openLink = document.querySelector("#openLink");
const copyButton = document.querySelector("#copyButton");

function setError(message = "") {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function setUploading(active) {
  input.disabled = active;
  selectButton.disabled = active;
  uploadTitle.textContent = active ? "Загружаем…" : "Перетащите изображение сюда";
  selectButton.innerHTML = active ? '<span class="spinner"></span>' : "Выбрать файл";
}

async function upload(file) {
  setError();
  result.hidden = true;
  copyButton.textContent = "Копировать";
  if (!file) return;

  if (!file.type.startsWith("image/")) return setError("Выберите файл изображения.");
  if (!file.size || file.size > MAX_SIZE) return setError("Размер изображения должен быть не больше 5 МБ.");

  fileMeta.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} МБ`;
  setUploading(true);

  try {
    const body = new FormData();
    body.set("file", file);
    const response = await fetch("/upload", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить файл");

    const url = `${location.origin}/sh/${data.id}`;
    preview.src = url;
    resultUrl.value = url;
    openLink.href = url;
    result.hidden = false;
  } catch (error) {
    setError(error instanceof Error ? error.message : "Не удалось загрузить файл");
  } finally {
    setUploading(false);
    input.value = "";
  }
}

selectButton.addEventListener("click", () => input.click());
input.addEventListener("change", () => upload(input.files?.[0]));

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  });
}

dropzone.addEventListener("drop", (event) => upload(event.dataTransfer?.files?.[0]));

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(resultUrl.value);
  } catch {
    resultUrl.select();
    document.execCommand("copy");
  }
  copyButton.textContent = "Скопировано";
  setTimeout(() => { copyButton.textContent = "Копировать"; }, 1800);
});
