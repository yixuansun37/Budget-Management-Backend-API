const router = require('express').Router();
router.use(require('../middleware/authMiddleware'), require('../middleware/authorize')());
router.get('/', require('../controllers/auditTrailController').list);
// No application endpoint permits editing or removing persisted audit records.
module.exports = router;
