import sharp from "sharp";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

await Promise.all([
  sharp(path("../assets/action.svg"))
    .resize(144, 144)
    .png()
    .toFile(path("../com.lumiverse.streamdeck.sdPlugin/imgs/action.png")),
  sharp(path("../assets/plugin.svg"))
    .resize(256, 256)
    .png()
    .toFile(path("../com.lumiverse.streamdeck.sdPlugin/imgs/plugin.png")),
  sharp(path("../assets/action.svg"))
    .resize(288, 288)
    .png()
    .toFile(path("../com.lumiverse.streamdeck.sdPlugin/imgs/action@2x.png")),
  sharp(path("../assets/plugin.svg"))
    .resize(512, 512)
    .png()
    .toFile(path("../com.lumiverse.streamdeck.sdPlugin/imgs/plugin@2x.png")),
  sharp(path("../assets/plugin.svg"))
    .resize(28, 28)
    .png()
    .toFile(path("../com.lumiverse.streamdeck.sdPlugin/imgs/category.png")),
  sharp(path("../assets/plugin.svg"))
    .resize(56, 56)
    .png()
    .toFile(path("../com.lumiverse.streamdeck.sdPlugin/imgs/category@2x.png")),
]);
