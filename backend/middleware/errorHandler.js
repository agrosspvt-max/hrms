/**
 * Express error handler.  Falls back to 500 if no status was set on res.
 */
const notFound = (req, res, next) => {
  res.status(404);
  next(new Error(`Not Found: ${req.originalUrl}`));
};

const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({
    message: err.message || 'Server error',
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
};

module.exports = { notFound, errorHandler };
