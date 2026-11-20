let websocket, uuid, actionInfo, context;
let requestedInitialCharacters = false;
let charactersById = new Map();
const server = document.getElementById("server");
const token = document.getElementById("token");
const character = document.getElementById("character");
const characterFields = document.getElementById("characterFields");
const status = document.getElementById("status");

function send(event, ctx, payload) { websocket.send(JSON.stringify({ event, context: ctx, payload })); }
function saveGlobal() { send("setGlobalSettings", uuid, { serverUrl: server.value.trim(), token: token.value.trim() }); }
function saveActionSettings(settings) {
  websocket.send(JSON.stringify({
    action: actionInfo.action,
    event: "setSettings",
    context: uuid,
    payload: settings,
  }));
}
function requestCharacters() {
  status.textContent = "Loading characters…";
  websocket.send(JSON.stringify({
    action: actionInfo.action,
    event: "sendToPlugin",
    context: uuid,
    payload: { request: "characters" },
  }));
}

window.connectElgatoStreamDeckSocket = (port, pluginUUID, registerEvent, info, rawActionInfo) => {
  uuid = pluginUUID;
  actionInfo = JSON.parse(rawActionInfo);
  context = actionInfo.context;
  websocket = new WebSocket(`ws://127.0.0.1:${port}`);
  websocket.onopen = () => {
    websocket.send(JSON.stringify({ event: registerEvent, uuid }));
    send("getGlobalSettings", uuid);
    if (actionInfo.action === "com.lumiverse.streamdeck.opencharacter") {
      characterFields.hidden = false;
    }
  };
  websocket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.event === "didReceiveGlobalSettings") {
      server.value = message.payload.settings.serverUrl || "http://localhost:3000";
      token.value = message.payload.settings.token || "";
      if (actionInfo.action === "com.lumiverse.streamdeck.opencharacter" && !requestedInitialCharacters) {
        requestedInitialCharacters = true;
        requestCharacters();
      }
    }
    if (message.event === "sendToPropertyInspector") {
      if (message.payload.error) { status.textContent = message.payload.error; return; }
      const selected = actionInfo.payload.settings.characterId || "";
      const characters = message.payload.characters || [];
      charactersById = new Map(characters.map((item) => [item.id, item]));
      character.length = 1;
      for (const item of characters) character.add(new Option(item.name, item.id, false, item.id === selected));
      const selectedCharacter = charactersById.get(selected);
      if (selectedCharacter && actionInfo.payload.settings.characterImageUrl !== selectedCharacter.image_url) {
        const settings = {
          characterId: selectedCharacter.id,
          characterName: selectedCharacter.name,
          characterImageUrl: selectedCharacter.image_url || "",
        };
        actionInfo.payload.settings = settings;
        saveActionSettings(settings);
      }
      status.textContent = "";
    }
  };
};

server.addEventListener("change", () => { saveGlobal(); requestCharacters(); });
token.addEventListener("change", () => { saveGlobal(); requestCharacters(); });
character.addEventListener("change", () => {
  const option = character.options[character.selectedIndex];
  const selectedCharacter = charactersById.get(character.value);
  const settings = {
    characterId: character.value,
    characterName: option?.text || "",
    characterImageUrl: selectedCharacter?.image_url || "",
  };
  actionInfo.payload.settings = settings;
  saveActionSettings(settings);
});
