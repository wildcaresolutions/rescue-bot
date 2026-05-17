# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Rescue Bot, please report it responsibly.

**Do NOT create public GitHub issues for security vulnerabilities.**

### How to Report

1. Email security details to the project maintainers
2. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes

### What to Expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Credit in security advisory (if desired)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Security Considerations

### API Keys
- Never commit API keys to the repository
- Store keys in environment variables only
- Use `.env` files (excluded from git)

### Authentication
- Password-based authentication using SHA-256 hashing
- Passwords stored as hashes, never plaintext
- Session cookies with configurable expiration

### Data Privacy
- No PII logged in production
- Session data can be cleared by users
- Feedback data anonymized in reports

### Input Validation
- All API endpoints validate input
- SQL injection prevented via parameterized queries
- XSS prevented via content sanitization

### Network Security
- HTTPS recommended for production
- CORS configured for allowed origins
- Rate limiting recommended for public deployments

## Best Practices for Deployment

1. Use HTTPS in production
2. Set strong passwords in `site.yaml`
3. Rotate API keys periodically
4. Monitor logs for suspicious activity
5. Keep dependencies updated
6. Use network firewalls to restrict access
