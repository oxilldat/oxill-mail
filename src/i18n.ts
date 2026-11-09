import type { MailLocale } from "./types";

let locale: MailLocale = "ru";

export function setMailLocale(value: MailLocale): void { locale = value; }
export function t(ru: string, en: string): string { return locale === "ru" ? ru : en; }
