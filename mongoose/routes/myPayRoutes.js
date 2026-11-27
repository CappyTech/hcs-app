import express from 'express';
import staffologyPayroll from '../controllers/staffologyPayrollController.js';
import { isStaffologyMode } from '../../services/staffologyModeService.js';

// My pay: a signed-in person's own Staffology pay entries and payslips.
// Only in Staffology mode (404 otherwise). The user must be linked to an
// employee whose Payroll ID is their Staffology payroll code; a payslip is
// only ever served for the user's own code (staffologyPayrollController).
const router = express.Router();

const onlyInStaffologyMode = (req, res, next) => (isStaffologyMode() ? next() : next('router'));

router.get('/my-pay', onlyInStaffologyMode, staffologyPayroll.renderMyPay);
router.get('/my-pay/:entryUuid/payslip', onlyInStaffologyMode, staffologyPayroll.myPayslip);

export default router;
