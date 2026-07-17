import type { Response } from "express";
import { logger } from "./logger";

class SSEManager {
  private clients = new Set<Response>();

  addClient(res: Response): void {
    this.clients.add(res);
    logger.info({ clientCount: this.clients.size }, "SSE client connected");
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
    logger.info({ clientCount: this.clients.size }, "SSE client disconnected");
  }

  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  heartbeat(): void {
    if (this.clients.size === 0) return;
    for (const client of this.clients) {
      try {
        client.write(":ping\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const sseManager = new SSEManager();
