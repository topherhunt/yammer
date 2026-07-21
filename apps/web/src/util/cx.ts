// Tiny classnames helper: join truthy parts with spaces.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
