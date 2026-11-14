/** Intake form shape (shared by /new and the server action) and the seeded demo values. */
export interface IntakeInput {
  name: string; phone: string; email?: string;
  date: string; place: string; description: string;
  otherDriverName?: string; otherDriverPlate?: string; otherDriverInsurer?: string;
  policyNumber: string; policeReportNumber?: string; injuries: boolean;
  vin: string; make?: string; model?: string; year?: number;
  message?: string;
}


export const DEMO_INTAKE: IntakeInput = {
  name: "Dana Reyes", phone: "+15550109999", email: "dana@example.com",
  date: new Date().toISOString().slice(0, 10), place: "Main St & 3rd Ave, Springfield",
  description: "I was stopped at a red light and a pickup truck rear-ended me. My neck hurts.",
  otherDriverName: "J. Smith", otherDriverPlate: "7ABC123", otherDriverInsurer: "Other Mutual",
  policyNumber: "POL-88812", policeReportNumber: "PR-55120", injuries: true,
  vin: "1HGCM82633A004352", make: "Honda", model: "Accord", year: 2021,
};

