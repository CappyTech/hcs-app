import express from 'express';
import authService from '../../services/authService.js';
import ctrl from '../controllers/searchController.js';

// Database-wide search. Anyone signed in may search; what they find is
// limited to the collections their role may list and the records the
// ownership scoping lets them see (searchService).
const router = express.Router();

router.get('/search', authService.ensureAuthenticated, ctrl.getSearch);

export default router;
