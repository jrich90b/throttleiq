import * as path from "node:path";

export function getDataDir(): string {
  return process.env.DATA_DIR?.trim() || path.resolve(process.cwd(), "data");
}

export function dataPath(filename: string): string {
  return path.resolve(getDataDir(), filename);
}
