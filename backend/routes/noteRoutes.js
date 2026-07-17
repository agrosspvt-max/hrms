const router = require('express').Router();
const { protect } = require('../middleware/auth');
const c = require('../controllers/noteController');

router.use(protect);

// Note Types (notebook definitions)
router.get('/types',        c.listTypes);
router.post('/types',       c.createType);
router.patch('/types/:id',  c.updateType);
router.delete('/types/:id', c.deleteType);

// Notes
router.get('/',       c.list);
router.post('/',      c.create);
router.get('/:id',    c.getOne);
router.patch('/:id',  c.update);
router.delete('/:id', c.remove);

module.exports = router;
