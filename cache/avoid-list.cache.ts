import fs from 'fs';
import path from 'path';
import { logger } from '../helpers';

const AVOID_LIST_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class AvoidListCache {
  private avoidList: string[] = [];
  private fileLocation = path.join(__dirname, '../avoid-list.txt');

  constructor() {
    // If the file does not exist, create an empty one
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
    return this.avoidList.includes(mint);
  }

  private loadAvoidList() {
    logger.trace(`Refreshing avoid list...`);

    const count = this.avoidList.length;
    const data = fs.readFileSync(this.fileLocation, 'utf-8');
    this.avoidList = data
      .split('\n')
      .map((a) => a.trim())
      .filter((a) => a);

    if (this.avoidList.length != count) {
      logger.info(`Loaded avoid list: ${this.avoidList.length}`);
    }
  }
}
