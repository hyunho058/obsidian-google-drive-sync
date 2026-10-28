import { parseFolderRef } from "../src/drive/folder-ref";
import { test, assert, run } from "./harness";

const ID = "1AbC_d-9xyz";

/** Runs every input through parseFolderRef and names each one that disagrees. */
function expectAll(inputs: string[], expected: string | null): void {
  const wrong: string[] = [];
  for (const input of inputs) {
    const actual = parseFolderRef(input);
    if (actual !== expected) {
      wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
    }
  }
  assert(
    wrong.length === 0,
    `expected ${JSON.stringify(expected)} for every input; wrong:\n     ${wrong.join("\n     ")}`,
  );
}

test("R1.1 folder links in every documented form yield the ID", () => {
  expectAll(
    [
      `https://drive.google.com/drive/folders/${ID}`,
      `https://drive.google.com/drive/u/1/folders/${ID}?usp=sharing`,
      `https://drive.google.com/drive/mobile/folders/${ID}`,
      `https://www.drive.google.com/open?id=${ID}#x`,
      `https://drive.google.com/folderview?id=${ID}`,
      `drive.google.com/drive/folders/${ID}`,
      `  ${ID}  `,
    ],
    ID,
  );
});

test("R1.2 anything that is not a folder link or ID yields null", () => {
  expectAll(
    [
      `https://drive.google.com/file/d/${ID}/view`,
      `https://example.com/drive/folders/${ID}`,
      "my notes folder",
      "short",
      `${ID} extra`,
      "",
    ],
    null,
  );
});

void run();
