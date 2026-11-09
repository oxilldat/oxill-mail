import { afterEach, describe, expect, it } from "vitest";

import { setMailLocale, t } from "./i18n";

describe("mail localization", () => {
  afterEach(() => setMailLocale("ru"));

  it("uses Russian by default", () => {
    expect(t("Почта", "Mail")).toBe("Почта");
  });

  it("switches to English", () => {
    setMailLocale("en");
    expect(t("Почта", "Mail")).toBe("Mail");
  });
});
