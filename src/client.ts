import type { Account } from "./execution.js";
import type { Market, Book } from "./domain.js";
export type Envelope<T> = { data: T; meta?: { nextCursor: number } };
/** Server/BFF client. Do not embed installation tokens in browser bundles. */
export class BotClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Envelope<T>> {
    const r = await fetch(`${this.baseUrl}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      throw Object.assign(Error(`bot_http_${r.status}`), {
        status: r.status,
        detail: await r.json(),
      });
    return r.json() as Promise<Envelope<T>>;
  }
  accounts() {
    return this.request<Account[]>("/accounts");
  }
  markets() {
    return this.request<Market[]>("/markets");
  }
  book(id: string) {
    return this.request<Book | null>(`/markets/${encodeURIComponent(id)}/book`);
  }
  pause(id: string) {
    return this.request<Account>(
      `/accounts/${encodeURIComponent(id)}`,
      "PATCH",
      { enabled: false },
    );
  }
  selectStrategies(id: string, enabledSlots: string[]) {
    return this.request<{ enabledSlots: string[] }>(
      `/accounts/${encodeURIComponent(id)}/strategies`,
      "PUT",
      { enabledSlots },
    );
  }
}
