import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("com.lumiverse.streamdeck.sdPlugin/profiles");
const pluginId = "com.lumiverse.streamdeck";

const profiles = [
  { file: "Lumiverse Browser", id: "2D6641C7-8864-42BB-8E46-AB149090D301", model: "20GBA9901", columns: 5, rows: 3 },
  { file: "Lumiverse Browser Mini", id: "2D6641C7-8864-42BB-8E46-AB149090D302", model: "20GAI9901", columns: 3, rows: 2 },
  { file: "Lumiverse Browser XL", id: "2D6641C7-8864-42BB-8E46-AB149090D303", model: "20GAT9901", columns: 8, rows: 4 },
  { file: "Lumiverse Browser Plus", id: "2D6641C7-8864-42BB-8E46-AB149090D304", model: "20GBD9901", columns: 4, rows: 2 },
];

function state(title = "") {
  return { FFamily: "", FSize: "10", FStyle: "", FUnderline: "off", Image: "", Title: title, TitleAlignment: "middle", TitleColor: "#ffffff", TitleShow: "" };
}

function action(name, uuid, settings, title = "") {
  return { Name: name, Settings: settings, State: 0, States: [state(title)], UUID: uuid };
}

function profileManifest(profile) {
  const actions = {};
  const controls = ["back", "toggle", "previous", "next"];
  const controlPositions = [];
  for (let column = profile.columns - controls.length; column < profile.columns; column += 1) {
    controlPositions.push(`${column},${profile.rows - 1}`);
  }
  const reserved = new Set(controlPositions);
  let slot = 0;
  for (let row = 0; row < profile.rows; row += 1) {
    for (let column = 0; column < profile.columns; column += 1) {
      const position = `${column},${row}`;
      if (reserved.has(position)) continue;
      actions[position] = action("Lumiverse Browser Result", `${pluginId}.browserslot`, { slot });
      slot += 1;
    }
  }
  controlPositions.forEach((position, index) => {
    actions[position] = action("Lumiverse Browser Control", `${pluginId}.browsercontrol`, { control: controls[index] });
  });
  return {
    Actions: actions,
    DeviceModel: profile.model,
    InstalledByPluginUUID: pluginId,
    Name: profile.file,
    PreconfiguredName: `profiles/${profile.file}`,
    Version: "1.0",
  };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipSingleFile(name, data) {
  const filename = Buffer.from(name);
  const content = Buffer.from(data);
  const crc = crc32(content);
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28); filename.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + content.length, 16);
  return Buffer.concat([local, content, central, end]);
}

await mkdir(outDir, { recursive: true });
for (const profile of profiles) {
  const entry = `${profile.id}.sdProfile/manifest.json`;
  const json = JSON.stringify(profileManifest(profile));
  await writeFile(path.join(outDir, `${profile.file}.streamDeckProfile`), zipSingleFile(entry, json));
}
