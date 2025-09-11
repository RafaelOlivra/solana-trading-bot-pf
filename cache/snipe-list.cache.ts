import fs from 'fs';
import path from 'path';
import { logger, SNIPE_LIST_REFRESH_INTERVAL } from '../helpers';

export class SnipeListCache {
  private snipeList: string[] = [];
  private fileLocation = path.join(__dirname, '../snipe-list.txt');

  constructor() {
    // If the file does not exist, create an empty one
    if (!fs.existsSync(this.fileLocation)) {
      fs.writeFileSync(this.fileLocation, '');
      logger.info(`Created empty snipe list at ${this.fileLocation}`);
    }

    setInterval(() => this.loadSnipeList(), SNIPE_LIST_REFRESH_INTERVAL);
  }

  public init() {
    this.loadSnipeList();
  }

  public isInList(mint: string) {
    return this.snipeList.includes(mint);
  }

  private loadSnipeList() {
    logger.trace(`Refreshing snipe list...`);

    const count = this.snipeList.length;
    const data = fs.readFileSync(this.fileLocation, 'utf-8');
    this.snipeList = data
      .split('\n')
      .map((a) => a.trim())
      .filter((a) => a);

    if (this.snipeList.length != count) {
      logger.info(`Loaded snipe list: ${this.snipeList.length}`);
    }
  }
}
