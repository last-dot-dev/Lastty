export function encodeAnsiBase64(ansi: string): string {
  const bytes = new TextEncoder().encode(ansi);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
