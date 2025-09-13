import fs from 'fs';
import path from 'path';
import { logger } from '../helpers';

const AVOID_LIST_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

export interface AvoidListEntry {
  address: string;
  note?: string;
}

export class AvoidListCache {
  private avoidList: AvoidListEntry[] = [];
  private fileLocation = path.join(__dirname, '../avoid-list.txt');

  constructor() {
    if (!fs.existsSync(this.fileLocation)) {
      fs.writeFileSync(this.fileLocation, '');
      logger.info(`Created empty avoid list at ${this.fileLocation}`);
    }

    setInterval(() => this.loadAvoidList(), AVOID_LIST_REFRESH_INTERVAL);
  }

  public init() {
    this.loadAvoidList();
  }

  public isInList(mint: string) {
    return this.avoidList.some((entry) => entry.address === mint);
  }

  public add(address: string, note?: string) {
    if (this.isInList(address)) {
      logger.warn(`Address already in avoid list: ${address}`);
      return;
    }

    const entry: AvoidListEntry = { address, note };
    this.avoidList.push(entry);

    const line = note ? `${address},${JSON.stringify(note)}` : address;
    fs.appendFileSync(this.fileLocation, line + '\n');

    logger.info(`Added to avoid list: ${line}`);
  }

  private loadAvoidList() {
    logger.trace(`Refreshing avoid list...`);

    const prevCount = this.avoidList.length;
    const data = fs.readFileSync(this.fileLocation, 'utf-8');

    this.avoidList = data
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [address, ...rest] = line.split(',');

        if (!rest.length) {
          return { address };
        }

        const raw = rest.join(',').trim();
        let note: string | undefined;

        try {
          note = JSON.parse(raw);
        } catch {
          // fallback if somehow not JSON (old format)
          note = raw;
        }

        return { address: address.trim(), note };
      });

    if (this.avoidList.length !== prevCount) {
      logger.info(`Loaded avoid list: ${this.avoidList.length}`);
    }
  }
}
