import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { de } from "./de";
import { setLanguage, t, te } from "./i18n";

/** Strings that stay the same in German: names, and shortcuts whose key caps are translated where they are drawn. */
const SAME = /^(Uplinq|Studio|Uplinq Studio|\{0\} – Uplinq Studio|\{0\}\+.*|English|Deutsch)$/;
const technical = (k: string) => SAME.test(k) || !/[A-Za-z]{3}/.test(k.replace(/\{\d+\}/g, ""));

describe("German", () => {
  it("has every interface string", () => {
    const keys: string[] = JSON.parse(execFileSync("node", ["scripts/i18n-wrap.mjs", "--keys"], { encoding: "utf8" }));
    expect(keys.length).toBeGreaterThan(400);
    const missing = keys.filter((k) => !(k in de) && !technical(k));
    expect(missing).toEqual([]);
  });

  it("keeps the placeholders of every string", () => {
    const holes = (s: string) => [...new Set([...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]))].sort().join();
    const wrong = Object.entries(de).filter(([en, own]) => holes(en) !== holes(own));
    expect(wrong.map(([en]) => en)).toEqual([]);
  });
});

describe("translation", () => {
  it("translates, fills in and falls back", () => {
    setLanguage("de");
    expect(t("Connect to {0}", "example.com")).toBe("Mit example.com verbinden");
    expect(t("Not in the table {0}", "x")).toBe("Not in the table x");
    expect(t("{0} {1}", "PNG", t("image"))).toBe("PNG-Bild");
    setLanguage("en");
    expect(t("Connect to {0}", "example.com")).toBe("Connect to example.com");
  });

  it("translates messages from the Rust side", () => {
    setLanguage("de");
    // Quoted names and numbers are placeholders.
    expect(te("Can't read “docs”.")).toBe("„docs“ kann nicht gelesen werden.");
    expect(te("The server replied with error 550.")).toBe("Der Server hat mit Fehler 550 geantwortet.");
    // Details from the server at the end stay as they came.
    expect(te("The server rejected the login. Check the username and password. (530 Login incorrect.)")).toBe(
      "Der Server hat die Anmeldung abgelehnt. Prüfen Sie Benutzername und Kennwort. (530 Login incorrect.)",
    );
    expect(te("The connection to the server was lost (broken pipe).")).toBe(
      "Die Verbindung zum Server wurde unterbrochen. (broken pipe)",
    );
    // "Prefix: detail".
    expect(te("Network error: connection reset")).toBe("Netzwerkfehler: connection reset");
    // A quoted setting name is translated too.
    expect(
      te(
        "The server's certificate isn't trusted. This usually means it's self-signed or expired. If you trust this server, turn on “Trust any certificate” under Advanced in the site settings. (UnknownIssuer)",
      ),
    ).toContain("„Jedem Zertifikat vertrauen“ ein. (UnknownIssuer)");
    expect(te("Something the table does not know")).toBe("Something the table does not know");
    setLanguage("en");
    expect(te("Network error: connection reset")).toBe("Network error: connection reset");
  });
});
