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
