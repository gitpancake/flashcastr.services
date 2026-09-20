export interface PromoteGateway {
  promoteFeedToKeep(flashId: number, ipfsCid: string): Promise<void>;
}
