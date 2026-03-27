export interface AppUser {
  fid: number;
  username: string;
  auto_cast: boolean;
}

export type SignupState =
  | "idle"
  | "searching"
  | "found"
  | "not_found"
  | "initiating"
  | "awaiting_approval"
  | "polling"
  | "complete"
  | "error";

export interface InitiateSignupResponse {
  signer_uuid: string;
  public_key: string;
  status: string;
  signer_approval_url: string | null;
  fid: number | null;
}

export interface PollSignupResponse {
  status: string;
  fid: number | null;
  user: AppUser | null;
  message: string | null;
}
