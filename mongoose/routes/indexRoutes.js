const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const index = require("../controllers/indexController");

router.get("/", authService.ensureRole("public"), index.renderIndex);
router.post("/quick-task", authService.ensureRole("public"), index.quickAddTask);
router.post("/task/:uuid/complete", authService.ensureRole("public"), index.completeTask);
router.get("/admin", authService.ensureRole("admin"), index.renderAdmin);
router.get(
  "/attendance",
  authService.ensureRoles("admin", "employee", "subcontractor"),
  index.renderAttendance,
);
router.get(
  "/construction-industry-scheme",
  authService.ensureRoles("admin", "accountant", "hmrc", "subcontractor"),
  index.renderConstructionIndustryScheme,
);
router.get(
  "/management",
  authService.ensureRole("admin"),
  index.renderManagement,
);
router.get(
  "/maintenance",
  authService.ensureRole("admin"),
  index.renderMaintenance,
);
router.get("/payroll", authService.ensureRole("admin"), index.renderPayroll);
router.get(
  "/human-resources",
  authService.ensureRole("admin"),
  index.renderHumanResources,
);
router.get(
  "/kashflow",
  authService.ensureRoles("admin", "accountant"),
  index.renderKashflow,
);
router.get("/create", authService.ensureRole("admin"), index.renderCreate);
router.get(
  "/paperless",
  authService.ensureRole("admin"),
  index.renderPaperless,
);
router.get(
  "/finance",
  authService.ensureRoles("admin", "accountant"),
  index.renderFinance,
);
router.get(
  "/user",
  authService.ensureRole("public"),
  index.renderUser,
);
module.exports = router;
