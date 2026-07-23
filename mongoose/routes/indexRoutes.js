import express from 'express';
const router = express.Router();
import authService from '../../services/authService.js';
import index from '../controllers/indexController.js';
import departments from '../config/departmentsConfig.js';

router.get("/", authService.ensureRole("public"), index.renderIndex);
router.post("/quick-task", authService.ensureRole("public"), index.quickAddTask);
router.post("/task/:uuid/complete", authService.ensureRole("public"), index.completeTask);
// One dashboard route per department, driven by departmentsConfig
Object.entries(departments)
  .filter(([, dept]) => dept.hasDashboard !== false)
  .forEach(([slug, dept]) => {
    const guard = dept.roles.includes("public")
      ? authService.ensureRole("public")
      : authService.ensureRoles(...dept.roles);
    router.get(dept.path || `/${slug}`, guard, index.renderDepartment(slug));
  });

// Legacy department URLs — kashflow merged into finance, paperless
// dashboard merged into documents (the /paperless/* OCR routes still exist)
router.get(
  "/kashflow",
  authService.ensureRoles("admin", "accountant"),
  (req, res) => res.redirect("/finance"),
);
router.get("/paperless", authService.ensureRole("admin"), (req, res) =>
  res.redirect("/documents"),
);

export default router;
