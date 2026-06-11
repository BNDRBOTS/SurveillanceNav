/**
 * U.S. public-records statutes by state — powers the FOIA request builder
 * (correct statute citation per jurisdiction) and deadline tracking.
 *
 * responseDays: statutory initial response window. businessDays indicates
 * whether the window counts business days (true) or calendar days (false).
 * null responseDays = statute requires a response within a "reasonable time"
 * with no fixed day count; the tracker defaults these to a 10-business-day
 * follow-up reminder.
 *
 * Statute citations verified against state codes as of 2025. Deadlines can
 * change; the admin console can override per-jurisdiction values
 * (settings key `foia.deadlineOverrides`).
 */

export interface FoiaStatute {
  state: string;
  abbr: string;
  lawName: string;
  citation: string;
  responseDays: number | null;
  businessDays: boolean;
  notes?: string;
}

export const FOIA_STATUTES: FoiaStatute[] = [
  { state: 'Alabama', abbr: 'AL', lawName: 'Alabama Open Records Act', citation: 'Ala. Code § 36-12-40', responseDays: null, businessDays: true, notes: 'Reasonable time standard.' },
  { state: 'Alaska', abbr: 'AK', lawName: 'Alaska Public Records Act', citation: 'Alaska Stat. § 40.25.110', responseDays: 10, businessDays: true },
  { state: 'Arizona', abbr: 'AZ', lawName: 'Arizona Public Records Law', citation: 'Ariz. Rev. Stat. § 39-121', responseDays: null, businessDays: true, notes: 'Promptly; no fixed deadline.' },
  { state: 'Arkansas', abbr: 'AR', lawName: 'Arkansas Freedom of Information Act', citation: 'Ark. Code § 25-19-105', responseDays: 3, businessDays: true },
  { state: 'California', abbr: 'CA', lawName: 'California Public Records Act', citation: 'Cal. Gov. Code § 7920.000 et seq.', responseDays: 10, businessDays: false, notes: '10 calendar days; 14-day extension permitted in unusual circumstances.' },
  { state: 'Colorado', abbr: 'CO', lawName: 'Colorado Open Records Act', citation: 'Colo. Rev. Stat. § 24-72-203', responseDays: 3, businessDays: true, notes: 'Extendable to 10 business days for extenuating circumstances.' },
  { state: 'Connecticut', abbr: 'CT', lawName: 'Connecticut Freedom of Information Act', citation: 'Conn. Gen. Stat. § 1-210', responseDays: 4, businessDays: true },
  { state: 'Delaware', abbr: 'DE', lawName: 'Delaware Freedom of Information Act', citation: '29 Del. C. § 10003', responseDays: 15, businessDays: true },
  { state: 'District of Columbia', abbr: 'DC', lawName: 'DC Freedom of Information Act', citation: 'D.C. Code § 2-532', responseDays: 15, businessDays: true },
  { state: 'Florida', abbr: 'FL', lawName: 'Florida Public Records Law', citation: 'Fla. Stat. ch. 119', responseDays: null, businessDays: true, notes: 'Reasonable time and good faith standard.' },
  { state: 'Georgia', abbr: 'GA', lawName: 'Georgia Open Records Act', citation: 'O.C.G.A. § 50-18-71', responseDays: 3, businessDays: true },
  { state: 'Hawaii', abbr: 'HI', lawName: 'Uniform Information Practices Act', citation: 'Haw. Rev. Stat. § 92F-11', responseDays: 10, businessDays: true },
  { state: 'Idaho', abbr: 'ID', lawName: 'Idaho Public Records Act', citation: 'Idaho Code § 74-103', responseDays: 3, businessDays: true, notes: '3 business days, extendable to 10.' },
  { state: 'Illinois', abbr: 'IL', lawName: 'Illinois Freedom of Information Act', citation: '5 ILCS 140', responseDays: 5, businessDays: true },
  { state: 'Indiana', abbr: 'IN', lawName: 'Indiana Access to Public Records Act', citation: 'Ind. Code § 5-14-3', responseDays: 7, businessDays: false, notes: '7 days for mailed requests; 24h for in-person.' },
  { state: 'Iowa', abbr: 'IA', lawName: 'Iowa Open Records Law', citation: 'Iowa Code ch. 22', responseDays: 20, businessDays: false, notes: 'Good-faith delay up to 20 calendar days.' },
  { state: 'Kansas', abbr: 'KS', lawName: 'Kansas Open Records Act', citation: 'Kan. Stat. § 45-218', responseDays: 3, businessDays: true },
  { state: 'Kentucky', abbr: 'KY', lawName: 'Kentucky Open Records Act', citation: 'Ky. Rev. Stat. § 61.880', responseDays: 5, businessDays: true },
  { state: 'Louisiana', abbr: 'LA', lawName: 'Louisiana Public Records Act', citation: 'La. Rev. Stat. § 44:32', responseDays: 3, businessDays: true },
  { state: 'Maine', abbr: 'ME', lawName: 'Maine Freedom of Access Act', citation: '1 M.R.S. § 408-A', responseDays: 5, businessDays: true, notes: 'Acknowledgement within 5 business days.' },
  { state: 'Maryland', abbr: 'MD', lawName: 'Maryland Public Information Act', citation: 'Md. Code, Gen. Prov. § 4-203', responseDays: 30, businessDays: false, notes: '10 business days if no denial anticipated; 30 calendar days max.' },
  { state: 'Massachusetts', abbr: 'MA', lawName: 'Massachusetts Public Records Law', citation: 'Mass. Gen. Laws ch. 66, § 10', responseDays: 10, businessDays: true },
  { state: 'Michigan', abbr: 'MI', lawName: 'Michigan Freedom of Information Act', citation: 'Mich. Comp. Laws § 15.235', responseDays: 5, businessDays: true },
  { state: 'Minnesota', abbr: 'MN', lawName: 'Minnesota Government Data Practices Act', citation: 'Minn. Stat. § 13.03', responseDays: null, businessDays: true, notes: 'Reasonable time; prompt for data subjects.' },
  { state: 'Mississippi', abbr: 'MS', lawName: 'Mississippi Public Records Act', citation: 'Miss. Code § 25-61-5', responseDays: 7, businessDays: true },
  { state: 'Missouri', abbr: 'MO', lawName: 'Missouri Sunshine Law', citation: 'Mo. Rev. Stat. § 610.023', responseDays: 3, businessDays: true },
  { state: 'Montana', abbr: 'MT', lawName: 'Montana Public Records Act', citation: 'Mont. Code § 2-6-1006', responseDays: null, businessDays: true, notes: 'Timely manner standard.' },
  { state: 'Nebraska', abbr: 'NE', lawName: 'Nebraska Public Records Statutes', citation: 'Neb. Rev. Stat. § 84-712', responseDays: 4, businessDays: true },
  { state: 'Nevada', abbr: 'NV', lawName: 'Nevada Public Records Act', citation: 'Nev. Rev. Stat. § 239.0107', responseDays: 5, businessDays: true },
  { state: 'New Hampshire', abbr: 'NH', lawName: 'New Hampshire Right-to-Know Law', citation: 'N.H. Rev. Stat. § 91-A:4', responseDays: 5, businessDays: true },
  { state: 'New Jersey', abbr: 'NJ', lawName: 'New Jersey Open Public Records Act', citation: 'N.J.S.A. 47:1A-5', responseDays: 7, businessDays: true },
  { state: 'New Mexico', abbr: 'NM', lawName: 'Inspection of Public Records Act', citation: 'N.M. Stat. § 14-2-8', responseDays: 15, businessDays: false, notes: 'Permit inspection within 15 calendar days; 3-day acknowledgement.' },
  { state: 'New York', abbr: 'NY', lawName: 'New York Freedom of Information Law', citation: 'N.Y. Pub. Off. Law § 89', responseDays: 5, businessDays: true, notes: '5 business days to acknowledge; 20 to substantively respond.' },
  { state: 'North Carolina', abbr: 'NC', lawName: 'North Carolina Public Records Law', citation: 'N.C. Gen. Stat. § 132-6', responseDays: null, businessDays: true, notes: 'As promptly as possible.' },
  { state: 'North Dakota', abbr: 'ND', lawName: 'North Dakota Open Records Statute', citation: 'N.D. Cent. Code § 44-04-18', responseDays: null, businessDays: true, notes: 'Reasonable time standard.' },
  { state: 'Ohio', abbr: 'OH', lawName: 'Ohio Public Records Act', citation: 'Ohio Rev. Code § 149.43', responseDays: null, businessDays: true, notes: 'Reasonable period of time.' },
  { state: 'Oklahoma', abbr: 'OK', lawName: 'Oklahoma Open Records Act', citation: '51 Okla. Stat. § 24A.5', responseDays: null, businessDays: true, notes: 'Prompt and reasonable access.' },
  { state: 'Oregon', abbr: 'OR', lawName: 'Oregon Public Records Law', citation: 'Or. Rev. Stat. § 192.329', responseDays: 5, businessDays: true, notes: 'Acknowledge in 5 business days; complete within 15 as practicable.' },
  { state: 'Pennsylvania', abbr: 'PA', lawName: 'Pennsylvania Right-to-Know Law', citation: '65 Pa. Stat. § 67.901', responseDays: 5, businessDays: true },
  { state: 'Rhode Island', abbr: 'RI', lawName: 'Access to Public Records Act', citation: 'R.I. Gen. Laws § 38-2-3', responseDays: 10, businessDays: true },
  { state: 'South Carolina', abbr: 'SC', lawName: 'South Carolina Freedom of Information Act', citation: 'S.C. Code § 30-4-30', responseDays: 10, businessDays: true, notes: '10 business days for records ≤24 months old; 20 for older.' },
  { state: 'South Dakota', abbr: 'SD', lawName: 'South Dakota Sunshine Law', citation: 'S.D. Codified Laws § 1-27-37', responseDays: 10, businessDays: true },
  { state: 'Tennessee', abbr: 'TN', lawName: 'Tennessee Public Records Act', citation: 'Tenn. Code § 10-7-503', responseDays: 7, businessDays: true },
  { state: 'Texas', abbr: 'TX', lawName: 'Texas Public Information Act', citation: 'Tex. Gov. Code ch. 552', responseDays: 10, businessDays: true },
  { state: 'Utah', abbr: 'UT', lawName: 'Government Records Access and Management Act', citation: 'Utah Code § 63G-2-204', responseDays: 10, businessDays: true },
  { state: 'Vermont', abbr: 'VT', lawName: 'Vermont Public Records Act', citation: '1 V.S.A. § 318', responseDays: 3, businessDays: true },
  { state: 'Virginia', abbr: 'VA', lawName: 'Virginia Freedom of Information Act', citation: 'Va. Code § 2.2-3704', responseDays: 5, businessDays: true },
  { state: 'Washington', abbr: 'WA', lawName: 'Washington Public Records Act', citation: 'Wash. Rev. Code § 42.56.520', responseDays: 5, businessDays: true },
  { state: 'West Virginia', abbr: 'WV', lawName: 'West Virginia Freedom of Information Act', citation: 'W. Va. Code § 29B-1-3', responseDays: 5, businessDays: true },
  { state: 'Wisconsin', abbr: 'WI', lawName: 'Wisconsin Open Records Law', citation: 'Wis. Stat. § 19.35', responseDays: null, businessDays: true, notes: 'As soon as practicable and without delay.' },
  { state: 'Wyoming', abbr: 'WY', lawName: 'Wyoming Public Records Act', citation: 'Wyo. Stat. § 16-4-202', responseDays: 7, businessDays: true, notes: 'Acknowledge within 7 business days; produce within 30 calendar days.' },
];

export const FEDERAL_FOIA: FoiaStatute = {
  state: 'United States (Federal)',
  abbr: 'US',
  lawName: 'Freedom of Information Act',
  citation: '5 U.S.C. § 552',
  responseDays: 20,
  businessDays: true,
};

export function statuteForState(stateNameOrAbbr: string): FoiaStatute | null {
  const needle = stateNameOrAbbr.trim().toLowerCase();
  return (
    FOIA_STATUTES.find((s) => s.state.toLowerCase() === needle || s.abbr.toLowerCase() === needle) ?? null
  );
}

/** Compute a due date from a sent date per statute rules (defaults to 10 business days). */
export function computeFoiaDueDate(sentAt: Date, statute: FoiaStatute | null): Date {
  const days = statute?.responseDays ?? 10;
  const business = statute?.businessDays ?? true;
  const due = new Date(sentAt);
  if (!business) {
    due.setDate(due.getDate() + days);
    return due;
  }
  let added = 0;
  while (added < days) {
    due.setDate(due.getDate() + 1);
    const dow = due.getDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return due;
}
