import { App, TFile } from "obsidian";

interface PersonNetworkContact {
  notePath: string;
  displayName: string;
  photoPath?: string;
  photoCrop?: { centerX: number; centerY: number; zoom: number };
}

interface PersonNetworkApi {
  findPersonByEmail(email: string): PersonNetworkContact | null;
}

interface PluginRegistryApp extends App {
  plugins?: { getPlugin(id: string): unknown };
}

export interface SenderAvatar {
  initial: string;
  color: string;
  imageUrl?: string;
  imagePosition?: string;
  imageScale?: number;
}

export class PersonNetworkConnector {
  private readonly cache = new Map<string, SenderAvatar>();

  constructor(private readonly app: App) {}

  resolve(email: string, fallbackName: string): SenderAvatar {
    const normalizedEmail = email.trim().toLocaleLowerCase();
    const key = normalizedEmail || `name:${fallbackName.trim().toLocaleLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const contact = normalizedEmail ? this.personNetwork()?.findPersonByEmail(normalizedEmail) ?? null : null;
    const name = contact?.displayName || fallbackName || email || "?";
    const avatar: SenderAvatar = { initial: name.trim().slice(0, 1).toLocaleUpperCase() || "?", color: this.colorFor(key) };
    if (contact?.photoPath) {
      const file = this.app.vault.getAbstractFileByPath(contact.photoPath);
      if (file instanceof TFile) {
        avatar.imageUrl = this.app.vault.getResourcePath(file);
        if (contact.photoCrop) {
          avatar.imagePosition = `${contact.photoCrop.centerX * 100}% ${contact.photoCrop.centerY * 100}%`;
          avatar.imageScale = contact.photoCrop.zoom;
        }
      }
    }
    this.cache.set(key, avatar);
    return avatar;
  }

  clear(): void { this.cache.clear(); }

  private personNetwork(): PersonNetworkApi | undefined {
    const plugin = (this.app as PluginRegistryApp).plugins?.getPlugin("person-network");
    return plugin && typeof (plugin as Partial<PersonNetworkApi>).findPersonByEmail === "function" ? plugin as PersonNetworkApi : undefined;
  }

  private colorFor(value: string): string {
    let hash = 0;
    for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    return `hsl(${Math.abs(hash) % 360} 48% 42%)`;
  }
}
