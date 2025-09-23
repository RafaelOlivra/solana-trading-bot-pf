import { Connection, Commitment, ConnectionConfig } from '@solana/web3.js';
import { COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from './constants';
import { logger } from './helpers';

type ConnectionArgs = {
  rpcEndpoint: string;
  rpcWsEndpoint: string;
  commitmentLevel: Commitment;
};

const VALID_COMMITMENTS: Commitment[] = ['processed', 'confirmed', 'finalized'];

/**
 * This Class works with multiple endpoints separated by ||
 * Each connection should have a corresponding wsEndpoint.
 * Commitment level will be the same for all connections.
 * e.g.:
 * RPC_ENDPOINT=https://config1.url||https://config2.url||https://config3.url
 * RPC_WEBSOCKET_ENDPOINT=wss://config1.url||wss://config2.url||wss://config3.url
 * COMMITMENT_LEVEL=confirmed
 */
export class CustomConnection {
  private connection: Connection;
  private connections: ConnectionArgs[];
  private lastIndex: number | null = null; // track last used index

  constructor(connectionArgs?: ConnectionArgs[]) {
    this.validateCommitmentLevel();

    // Use provided args or load from env
    this.connections =
      connectionArgs && connectionArgs.length > 0 ? connectionArgs : this.retrieveAvailableENVConnections();

    this.connection = this.getRandomConnection();
  }

  /**
   * Ensure commitment level is valid
   */
  private validateCommitmentLevel(): void {
    if (!VALID_COMMITMENTS.includes(COMMITMENT_LEVEL as Commitment)) {
      throw new Error(
        `Invalid COMMITMENT_LEVEL: "${COMMITMENT_LEVEL}". Must be one of: ${VALID_COMMITMENTS.join(', ')}`,
      );
    }
  }

  /**
   * Retrieves available connection configurations from env
   * @returns Array of connection configurations
   */
  private retrieveAvailableENVConnections(): ConnectionArgs[] {
    if (!RPC_ENDPOINT || !RPC_WEBSOCKET_ENDPOINT) {
      throw new Error('RPC_ENDPOINT and RPC_WEBSOCKET_ENDPOINT must be defined');
    }

    const rpcEndpoints = RPC_ENDPOINT.split('||').map((endpoint) => endpoint.trim());
    const rpcWsEndpoints = RPC_WEBSOCKET_ENDPOINT.split('||').map((endpoint) => endpoint.trim());

    if (rpcEndpoints.length !== rpcWsEndpoints.length) {
      throw new Error('Mismatch between RPC and WebSocket endpoints count');
    }

    return rpcEndpoints.map((rpcEndpoint, i) => ({
      rpcEndpoint,
      rpcWsEndpoint: rpcWsEndpoints[i],
      commitmentLevel: COMMITMENT_LEVEL as Commitment,
    }));
  }

  /**
   * Pick a random connection from available ones,
   * ensuring it's not the same as the last one
   */
  private getRandomConnection(): Connection {
    if (this.connections.length === 1) {
      // Only one available → always reuse
      this.lastIndex = 0;
      return new Connection(this.connections[0].rpcEndpoint, {
        commitment: this.connections[0].commitmentLevel,
        wsEndpoint: this.connections[0].rpcWsEndpoint,
      } as ConnectionConfig);
    }

    // Pick a different Connection than the last one
    let index: number;
    do {
      index = Math.floor(Math.random() * this.connections.length);
    } while (index === this.lastIndex);

    this.lastIndex = index;
    const connection = this.connections[index];

    logger.info(`Using RPC Endpoint: ${connection.rpcEndpoint} with WS: ${connection.rpcWsEndpoint}`);

    return new Connection(connection.rpcEndpoint, {
      commitment: connection.commitmentLevel,
      wsEndpoint: connection.rpcWsEndpoint,
    } as ConnectionConfig);
  }
  /**
   * Revert to a default Solana connection
   * (e.g., in case all custom RPCs fail)
   */
  public setDefaultSolanaConnection(): void {
    this.connection = new Connection('https://api.mainnet-beta.solana.com', {
      commitment: 'confirmed',
      wsEndpoint: 'wss://api.mainnet-beta.solana.com',
    } as ConnectionConfig);
    logger.warn('Reverted to default Solana connection');
  }

  /**
   * Get the current connection
   */
  public getConnection(): Connection {
    return this.connection;
  }

  /**
   * Refresh connection (e.g., in case of RPC failure)
   * Ensures new connection is not the same as the last one
   * @param useDefault If true, revert to default Solana connection
   * @returns The new Connection instance
   */
  public refreshConnection(useDefault: boolean = false): Connection {
    if (useDefault) {
      this.setDefaultSolanaConnection();
      return this.connection;
    }

    this.connection = this.getRandomConnection();
    return this.connection;
  }

  /**
   * List all available connection configurations
   */
  public listConnections(): ConnectionArgs[] {
    return this.connections;
  }
}
