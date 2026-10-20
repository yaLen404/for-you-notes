export function newId(prefix) {
  return prefix + String(Math.floor(Math.random() * 1e12));
}
