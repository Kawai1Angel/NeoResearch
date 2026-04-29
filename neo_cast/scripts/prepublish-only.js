"use strict";

const tag = process.env.npm_config_tag || "latest";

if (tag === "alpha") {
  process.exit(0);
}

console.error(
  [
    "Refusing to publish neo-cast without the alpha npm tag.",
    "",
    "Use:",
    "  npm publish --tag alpha --access public",
    "",
    `Current npm tag: ${tag}`,
  ].join("\n"),
);
process.exit(1);
