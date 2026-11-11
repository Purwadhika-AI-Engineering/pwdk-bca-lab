export interface LoginResponse {
  token: string;
  username: string;
  fullName: string;
}

export interface AccountView {
  accountNo: string;
  owner: string;
  accountType: string;
  balance: number;
  currency: string;
}

export interface AccountSummary {
  accountNo: string;
  maskedNo: string;
  owner: string;
  accountType: string;
  balance: number;
  currency: string;
  dailyLimit: number;
  dailyLimitUsed: number;
  dailyLimitRemaining: number;
}

export interface InquiryResponse {
  bankCode: string;
  bankName: string;
  accountNo: string;
  accountName: string;
}

export interface TransferDraft {
  fromAccount: string;
  toBankCode: string;
  toAccount: string;
  amount: number;
  note: string;
}

export interface TransferResponse {
  referenceNo: string;
  status: string;
  fromAccount: string;
  toBankCode: string;
  toBankName: string;
  toAccount: string;
  toName: string;
  amount: number;
  note: string | null;
  createdAt: string;
  balanceAfter: number | null;
}

export interface ApiError {
  errorCode: string;
  message: string;
}

export const BANKS = [
  { code: '999', name: 'Lab Bank' },
  { code: '002', name: 'BRI' },
  { code: '008', name: 'Bank Mandiri' },
  { code: '009', name: 'BNI' },
];
