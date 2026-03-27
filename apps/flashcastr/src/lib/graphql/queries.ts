export const UNIFIED_FLASHES_QUERY = `
  query UnifiedFlashes($page: Int, $limit: Int, $city: String, $player: String) {
    unifiedFlashes(page: $page, limit: $limit, city: $city, player: $player) {
      flash_id
      city
      player
      img
      ipfs_cid
      text
      timestamp
      flash_count
      farcaster_user {
        fid
        username
        pfp_url
        cast_hash
      }
      identification {
        id
        matched_flash_id
        matched_flash_name
        similarity
        confidence
      }
    }
  }
`;

export const FLASHCASTR_FLASHES_QUERY = `
  query Flashes($page: Int, $limit: Int, $fid: Int, $username: String, $city: String) {
    flashes(page: $page, limit: $limit, fid: $fid, username: $username, city: $city) {
      id
      flash_id
      user_fid
      user_username
      user_pfp_url
      cast_hash
      flash {
        flash_id
        city
        player
        img
        ipfs_cid
        text
        timestamp
        flash_count
      }
    }
  }
`;

export const FLASH_STORED_SUBSCRIPTION = `
  subscription FlashStored {
    flashStored {
      flash_id
      city
      player
      img
      ipfs_cid
      timestamp
    }
  }
`;
