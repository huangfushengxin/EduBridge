import { FileText, ScanLine } from "lucide-react";

export function PaperIllustration() {
  return <div className="paper-illustration" aria-hidden="true">
    <div className="paper-orbit paper-orbit-outer" />
    <div className="paper-orbit paper-orbit-inner" />
    <div className="paper-sheet paper-sheet-back"><i /><i /><i /></div>
    <div className="paper-sheet paper-sheet-front">
      <div className="paper-sheet-title"><FileText size={17} /><i /></div>
      <i /><i /><i />
      <div className="paper-checks"><span /><span /><span /></div>
    </div>
    <span className="paper-scan"><ScanLine size={22} /></span>
  </div>;
}
