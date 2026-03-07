export const typeDefs = `#graphql
  type User {
    fid: Int!
    username: String
    auto_cast: Boolean
  }

  type Flash {
    flash_id: ID!
    city: String
    player: String
    img: String
    ipfs_cid: String
    text: String
    timestamp: String
    flash_count: String
  }

  type FlashcastrFlash {
    id: Int!
    flash_id: String!
    user_fid: Int!
    user_username: String
    user_pfp_url: String
    cast_hash: String
    flash: Flash!
  }

  type FlashesSummary {
    flashCount: Int!
    cities: [String!]!
  }

  type DeleteUserResponse {
    success: Boolean!
    message: String!
  }

  type SignupResponse {
    success: Boolean!
    message: String!
  }

  type InitiateSignupResponse {
    signer_uuid: String!
    public_key: String!
    status: String!
    signer_approval_url: String
    fid: Int
  }

  type PollSignupStatusResponse {
    status: String!
    fid: Int
    user: User
    message: String
  }

  type TrendingCity {
    city: String!
    count: Int!
  }

  type LeaderboardEntry {
    username: String!
    pfp_url: String
    flash_count: Int!
    city_count: Int!
  }

  type FlashIdentification {
    id: Int!
    source_ipfs_cid: String!
    matched_flash_id: String!
    matched_flash_name: String
    similarity: Float!
    confidence: Float!
    created_at: String!
    matched_flash: Flash
  }

  type DailyProgress {
    date: String!
    count: Int!
  }

  type FarcasterUser {
    fid: Int!
    username: String
    pfp_url: String
    cast_hash: String
  }

  type FlashIdentificationInfo {
    id: Int!
    matched_flash_id: String!
    matched_flash_name: String
    similarity: Float!
    confidence: Float!
  }

  type UnifiedFlash {
    flash_id: ID!
    city: String
    player: String
    img: String
    ipfs_cid: String
    text: String
    timestamp: String
    flash_count: String
    farcaster_user: FarcasterUser
    identification: FlashIdentificationInfo
  }

  type FlashStoredEvent {
    flash_id: ID!
    city: String
    player: String
    img: String
    ipfs_cid: String
    timestamp: String
  }

  type FlashCastedEvent {
    flash_id: ID!
    city: String
    player: String
    cast_hash: String
    user_fid: Int
    user_username: String
  }

  type Query {
    users(username: String, fid: Int): [User!]!
    flashes(page: Int, limit: Int, fid: Int, username: String, city: String): [FlashcastrFlash!]!
    globalFlashes(page: Int, limit: Int, city: String, player: String): [Flash!]!
    globalFlash(flash_id: String!): Flash
    flash(id: Int!): FlashcastrFlash
    flashesSummary(fid: Int!, page: Int, limit: Int): FlashesSummary!
    allFlashesPlayers(username: String): [String!]!
    getAllCities: [String!]!
    getTrendingCities(excludeParis: Boolean = true, hours: Int = 6): [TrendingCity!]!
    getLeaderboard(limit: Int = 100): [LeaderboardEntry!]!
    pollSignupStatus(signer_uuid: String!, username: String!): PollSignupStatusResponse!
    progress(fid: Int!, days: Int!, order: String = "ASC"): [DailyProgress!]!
    flashIdentifications(ipfs_cid: String, matched_flash_id: String, limit: Int = 50): [FlashIdentification!]!
    flashIdentification(id: Int!): FlashIdentification
    unifiedFlash(flash_id: String!): UnifiedFlash
    unifiedFlashes(page: Int, limit: Int, city: String, player: String): [UnifiedFlash!]!
  }

  type Mutation {
    setUserAutoCast(fid: Int!, auto_cast: Boolean!): User!
    deleteUser(fid: Int!): DeleteUserResponse!
    signup(fid: Int!, signer_uuid: String!, username: String!): SignupResponse!
    initiateSignup(username: String!): InitiateSignupResponse!
    saveFlashIdentification(source_ipfs_cid: String!, matched_flash_id: String!, matched_flash_name: String, similarity: Float!, confidence: Float!): FlashIdentificationInfo
  }

  type Subscription {
    flashStored: FlashStoredEvent
    flashCasted: FlashCastedEvent
  }
`;
