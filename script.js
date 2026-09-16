const sidebar = document.querySelector("#sidebar");
const menuButton = document.querySelector("#menuButton");
const sidebarClose = document.querySelector("#sidebarClose");
const scrim = document.querySelector("#scrim");
const newChatButton = document.querySelector("#newChat");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const welcome = document.querySelector("#welcome");
const messages = document.querySelector("#messages");

const openSidebar = () => {
  sidebar.classList.add("is-open");
  scrim.classList.add("is-visible");
  document.body.style.overflow = "hidden";
};

const closeSidebar = () => {
  sidebar.classList.remove("is-open");
  scrim.classList.remove("is-visible");
  document.body.style.overflow = "";
};

const resizeTextarea = () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
  sendButton.disabled = !messageInput.value.trim();
};

const escapeHtml = (value) =>
  value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character],
  );

const addMessage = (role, text) => {
  const article = document.createElement("article");
  article.className = `message message--${role}`;

  const isAssistant = role === "assistant";
  article.innerHTML = `
    <div class="message__avatar" aria-hidden="true">${isAssistant ? "IF" : "AM"}</div>
    <div class="message__body">
      <strong>${isAssistant ? "Insforce" : "Tú"}</strong>
      <p>${escapeHtml(text)}</p>
      ${
        isAssistant
          ? '<div class="message__meta"><span></span> Respuesta de demostración · 3 fuentes</div>'
          : ""
      }
    </div>
  `;

  messages.append(article);
};

const showConversation = (prompt) => {
  welcome.hidden = true;
  messages.hidden = false;
  addMessage("user", prompt);

  window.setTimeout(() => {
    addMessage(
      "assistant",
      "Esta es una vista previa de la interfaz. La experiencia visual está lista; para obtener respuestas reales, conecta este chat con tu servicio RAG o API.",
    );
    messages.scrollIntoView({ behavior: "smooth", block: "end" });
  }, 380);
};

const resetConversation = () => {
  messages.replaceChildren();
  messages.hidden = true;
  welcome.hidden = false;
  messageInput.value = "";
  resizeTextarea();

  document.querySelectorAll(".chat-link").forEach((link) => link.classList.remove("is-active"));
  closeSidebar();
  messageInput.focus();
};

menuButton.addEventListener("click", openSidebar);
sidebarClose.addEventListener("click", closeSidebar);
scrim.addEventListener("click", closeSidebar);
newChatButton.addEventListener("click", resetConversation);

messageInput.addEventListener("input", resizeTextarea);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = messageInput.value.trim();
  if (!prompt) return;

  showConversation(prompt);
  messageInput.value = "";
  resizeTextarea();
});

document.querySelectorAll(".suggestion").forEach((suggestion) => {
  suggestion.addEventListener("click", () => {
    messageInput.value = suggestion.dataset.prompt;
    resizeTextarea();
    messageInput.focus();
  });
});

document.querySelectorAll(".chat-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".chat-link").forEach((item) => item.classList.remove("is-active"));
    link.classList.add("is-active");
    closeSidebar();
  });
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    resetConversation();
  }

  if (event.key === "Escape") closeSidebar();
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 820) closeSidebar();
});

resizeTextarea();
