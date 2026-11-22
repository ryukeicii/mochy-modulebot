// keeps the bot online in discord and watches module forums for new posts and zip uploads so it can offer one-click publish/update buttons

import { bot, type Message, type Thread } from "./discord.ts";
import { forumsOf, type Env } from "./env.ts";
import { GatewayIntents, looksPromptable, promptForMessage } from "./prompt.ts";

const Gateway = "https://gateway.discord.gg";
const Query = "/?v=10&encoding=json";

const Dispatch = 0;
const Heartbeat = 1;
const Identify = 2;
const Resume = 6;
const Reconnect = 7;
const InvalidSession = 9;
const Hello = 10;
const HeartbeatAck = 11;

// a wrong token or bad setup; trying again every few seconds would only burn discord's 1000 sign-ins a day
const FatalCloses = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const TenMinutes = 10 * 60 * 1000;

interface Payload {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}

// kept in storage so an object that was restarted picks up the old session instead of signing in again
interface Session {
  id: string | null;
  resumeUrl: string | null;
  seq: number | null;
  intents?: number;
}

// the little of a durable object's state this uses, typed here so the worker needs no packages
export interface ObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(time: number): Promise<void>;
  };
}

interface GatewaySocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: (event: { code?: number }) => void): void;
}

export class Presence {
  private socket: GatewaySocket | null = null;
  private interval = 41_250;
  private acked = true;
  private failures = 0;
  private session: Session | null = null;
  private savedSeq: number | null = null;
  private threads = new Map<string, Thread | null>();
  private prompted = new Set<string>();
  private state: ObjectState;
  private env: Env;

  constructor(state: ObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // the cron pokes this every 10 minutes, so the bot comes back even if the alarm ever stopped
  async fetch(): Promise<Response> {
    if (!this.socket) await this.connect();
    return new Response(JSON.stringify({ connected: !!this.socket }), { headers: { "Content-Type": "application/json" } });
  }

  async alarm(): Promise<void> {
    if (this.socket && this.acked) {
      this.acked = false;
      this.send({ op: Heartbeat, d: this.session?.seq ?? null });
      await this.saveSeq();
      await this.next(this.interval);
      return;
    }
    // no answer to the last heartbeat means the connection is dead even if it still looks open
    if (this.socket) {
      console.log("gateway stopped answering heartbeats, reconnecting");
      this.drop();
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.session ??= (await this.state.storage.get<Session>("session")) ?? { id: null, resumeUrl: null, seq: null };
    // when intents changed, start a fresh session so discord delivers the new events right away
    if (this.session.id && this.session.intents !== GatewayIntents) {
      this.session = { id: null, resumeUrl: null, seq: null };
    }
    const resuming = !!(this.session.id && this.session.resumeUrl);
    const base = resuming ? this.session.resumeUrl!.replace(/^wss:/, "https:") : Gateway;
    try {
      const response = await fetch(base + Query, { headers: { Upgrade: "websocket" } });
      const socket = (response as Response & { webSocket?: GatewaySocket | null }).webSocket;
      if (!socket) throw new Error(`gateway said ${response.status}`);
      socket.accept();
      this.listen(socket);
      this.socket = socket;
      this.acked = true;
      // hello sets the real first heartbeat; this only catches a gateway that never says hello
      await this.next(this.interval);
    } catch (e) {
      console.log(`couldn't reach the gateway: ${(e as Error).message}`);
      await this.backOff();
    }
  }

  private listen(socket: GatewaySocket): void {
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.onPayload(JSON.parse(String(event.data)) as Payload).catch((e) => console.log(`gateway message failed: ${(e as Error).message}`));
    });
    const lost = (code: number | undefined) => {
      if (this.socket !== socket) return;
      this.socket = null;
      console.log(`gateway closed with ${code}`);
      if (code !== undefined && FatalCloses.has(code)) {
        // a session discord threw out can't be resumed; the cron's next poke signs in fresh
        this.session = { id: null, resumeUrl: null, seq: null };
        this.state.storage.put("session", this.session).then(() => this.next(TenMinutes));
        return;
      }
      void this.backOff();
    };
    socket.addEventListener("close", (event) => lost(event.code));
    socket.addEventListener("error", () => lost(undefined));
  }

  private async onPayload(payload: Payload): Promise<void> {
    if (payload.s != null && this.session) this.session.seq = payload.s;
    switch (payload.op) {
      case Hello: {
        this.interval = payload.d.heartbeat_interval;
        const session = this.session!;
        if (session.id && session.resumeUrl) this.send({ op: Resume, d: { token: this.env.BOT_TOKEN, session_id: session.id, seq: session.seq } });
        else this.send({ op: Identify, d: { token: this.env.BOT_TOKEN, intents: GatewayIntents, properties: { os: "cloudflare", browser: "mochy-module-feed", device: "mochy-module-feed" }, presence: { status: "online", since: null, activities: [], afk: false } } });
        // discord asks for the first heartbeat at a random point in the first interval, so a crowd of bots doesn't beat together
        await this.next(Math.floor(this.interval * Math.random()));
        break;
      }
      case HeartbeatAck:
        this.acked = true;
        break;
      case Heartbeat:
        this.send({ op: Heartbeat, d: this.session?.seq ?? null });
        break;
      case Reconnect:
        this.drop();
        await this.next(1000);
        break;
      case InvalidSession:
        // false means the old session is gone for good, so the next try signs in fresh
        if (!payload.d) this.session = { id: null, resumeUrl: null, seq: null };
        await this.state.storage.put("session", this.session);
        this.drop();
        await this.next(1000 + Math.floor(Math.random() * 4000));
        break;
      case Dispatch:
        if (payload.t === "READY") {
          this.session = { id: payload.d.session_id, resumeUrl: payload.d.resume_gateway_url, seq: payload.s ?? null, intents: GatewayIntents };
          await this.state.storage.put("session", this.session);
          this.savedSeq = this.session.seq;
        }
        if (payload.t === "READY" || payload.t === "RESUMED") {
          this.failures = 0;
          console.log(payload.t === "READY" ? "online" : "back online");
        }
        if (payload.t === "THREAD_CREATE" && payload.d) {
          const thread = payload.d as Thread & { guild_id?: string };
          if (thread.guild_id === this.env.GUILD_ID && forumsOf(this.env).some((f) => f.id === thread.parent_id)) {
            this.rememberThread(thread.id, thread);
          }
        }
        if (payload.t === "MESSAGE_CREATE" && payload.d) {
          await this.onMessage(payload.d as Message & { channel_id: string; guild_id?: string; author: Message["author"] & { bot?: boolean } });
        }
        break;
    }
  }

  private async onMessage(message: Message & { channel_id: string; guild_id?: string; author: Message["author"] & { bot?: boolean } }): Promise<void> {
    if (message.guild_id !== this.env.GUILD_ID || !looksPromptable(message)) return;
    if (this.prompted.has(message.id)) return;
    let thread = this.threads.get(message.channel_id);
    if (thread === undefined) {
      const fetched = await bot<Thread>(this.env, `/channels/${message.channel_id}`).catch(() => null);
      thread = fetched && forumsOf(this.env).some((f) => f.id === fetched.parent_id) ? fetched : null;
      this.rememberThread(message.channel_id, thread);
    }
    if (!thread) return;
    this.rememberPrompted(message.id);
    await promptForMessage(this.env, thread, message).catch((e) => console.log(`couldn't post module prompt: ${(e as Error).message}`));
  }

  private rememberThread(id: string, thread: Thread | null): void {
    if (this.threads.size >= 500) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) this.threads.delete(oldest);
    }
    this.threads.set(id, thread);
  }

  private rememberPrompted(id: string): void {
    if (this.prompted.size >= 500) {
      const oldest = this.prompted.values().next().value;
      if (oldest !== undefined) this.prompted.delete(oldest);
    }
    this.prompted.add(id);
  }

  // closing with a code other than 1000 keeps the session, so the next connection can resume it
  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(4000, "reconnecting");
    } catch {
      // already closed
    }
  }

  private async backOff(): Promise<void> {
    this.failures++;
    await this.next(Math.min(TenMinutes, 1000 * 2 ** this.failures));
  }

  private async saveSeq(): Promise<void> {
    if (!this.session || this.session.seq === this.savedSeq) return;
    await this.state.storage.put("session", this.session);
    this.savedSeq = this.session.seq;
  }

  private send(payload: Payload): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private next(delay: number): Promise<void> {
    return this.state.storage.setAlarm(Date.now() + delay);
  }
}
