# HYFIT Games Backend Module

This directory contains the NestJS backend implementation for the HYFIT Games athlete platform.

## Overview

The HYFIT Games module is a port of a standalone Express + Postgres application into the Novarace NestJS backend. It provides:

- Athlete authentication via mobile + OTP
- Admin authentication via email/password
- Event management and registration
- Real-time timing data collection
- Results computation and ranking
- Performance analytics and dashboards
- Protest management during provisional results
- Certificate generation for finishers
- Administrative tools for event organizers

## Key Features

### Authentication
- Mobile number + OTP verification for athletes (with dev bypass OTP: 654321)
- Email/password authentication for administrators
- JWT-based stateless authentication with secure refresh token rotation
- Automatic token refresh handling in frontend

### Data Management
- Dedicated `hyfitgames` PostgreSQL schema for data isolation
- Connection pooling with automatic schema routing (`SET search_path=hyfitgames,public`)
- Redis-backed caching layer with namespace isolation (`hyfitgames:` prefix)
- Efficient read-heavy operations through aggressive caching
- Transactional consistency for writes

### Core Functionality
- Event creation, scheduling, and management
- Station (obstacle) configuration for events
- Athlete registration and bib assignment
- Split timing collection and aggregation
- Results computation with Olympic-style ranking (ties share rank)
- Age-group and gender-based rankings
- Protest submission and resolution workflow
- Finisher certificate generation with unique serials
- Comprehensive athlete performance dashboard
- Historical performance tracking and analytics

### API Endpoints
All endpoints are prefixed with `/api/hyfitgames`

#### Public Endpoints
- `GET /events` - List events
- `GET /events/:id` - Get event details
- `GET /events/:id/leaderboard` - Get event leaderboard
- `GET /events/:id/results` - Get event results
- `GET /events/:id/scorecard/:regId` - Get scorecard for registration
- `GET /events/:id/registrations/:regId/certificate` - Get certificate PDF

#### Athlete Authentication
- `POST /auth/otp/request` - Request OTP for mobile
- `POST /auth/otp/verify` - Verify OTP and get tokens
- `POST /auth/refresh` - Refresh access token
- `POST /auth/logout` - Logout (revoke refresh token)

#### Admin Authentication
- `POST /admin/login` - Admin login with email/password

#### Athlete Protected Routes (Requires Athlete Auth)
- `GET /me` - Get athlete profile
- `PATCH /me` - Update athlete profile
- `GET /me/events` - Get athlete's event registrations
- `GET /me/stats` - Get athlete performance statistics
- `GET /me/registrations/:regId` - Get registration details
- `POST /me/registrations/:regId/protest` - Submit protest
- `GET /me/registrations/:regId/certificate` - Download certificate

#### Admin Protected Routes (Requires Admin Auth)
- Full CRUD operations for events, stations, announcements
- Participant management and registration oversight
- Results computation and finalization controls
- Protest review and resolution interface
- Certificate generation and management

## Architecture

### Services
- `HfgDbService` - PostgreSQL connection pool with schema routing
- `HfgCacheService` - Wrapper around shared CacheService with namespaced keys
- `HfgOtpService` - OTP generation and validation (with rate limiting)
- `HfgResultsService` - Results computation and ranking algorithms
- `HfgImporterService` - Data import functionality from legacy systems
- `HfgCertificateService` - PDF certificate generation using PDFKit
- `HfgHealthController` - Health check endpoint
- `HfgAuthController` - Authentication endpoints (athlete and admin)
- `HfgAthleteController` - Athlete self-service functionality
- `HfgEventsController` - Public event data and athlete-specific endpoints
- `HfgTimingController` - Real-time timing data collection
- `HfgAdminController` - Administrative functions

### Guards
- `HfgAthleteGuard` - Protects athlete-specific routes
- `HfgAdminGuard` - Protects admin-specific routes
- `HfgTimingGuard` - Protects timing endpoints (IP-based or API key)

### Database Features
- Automatic schema routing eliminates need for table prefixing in queries
- Connection pooling tuned for concurrent user loads
- SSL/TLS support for database connections
- Prepared statement caching for repeated queries
- Transaction support for multi-operation consistency

### Caching Strategy
- Results computed and cached for frequent reads (leaderboards, results, event details)
- Cache invalidation on data mutations (registrations, results updates)
- Namespace isolation prevents conflicts with other modules
- TTL-based expiration with intelligent stale-while-revalidate patterns
- Memory-efficient serialization/deserialization

## Development

### Prerequisites
- Node.js 18.x or later
- PostgreSQL 13+ with PostGIS extension (if using geographic features)
- Redis 6+ for caching
- npm or yarn package manager

### Setup
1. Ensure parent project setup is handled by the main Novarace repository
2. The module is automatically loaded by the NestJS application
3. Database migrations are handled separately via the `backend/sql` directory
4. Environment variables are inherited from the main application:

```
# Database (shared with main app)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_password
DB_NAME=novarace
DB_SSL=false

# Redis (shared with main app)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Application
NODE_ENV=development
```

### Database Schema
See `backend/sql/026_create_hyfitgames_schema.sql` for the complete schema definition.

Key tables:
- `athletes` - Core athlete information
- `events` - Event metadata and scheduling
- `stations` - Race obstacles/stations (200m run + obstacle pattern)
- `registrations` - Athlete sign-ups for events
- `splits` - Individual timing data
- `results` - Computed results and rankings
- `protests` - Athlete challenges to results
- `certificates` - Issued finisher certificates
- `announcements` - Event-specific notices
- `hfg_cache` - Cache metadata table

### Running Tests
```bash
# From the backend directory
npm run test          # Unit tests
npm run test:e2e      # End-to-end tests
npm run test:cov      # Test coverage report
```

### Project Structure
```
src/hyfitgames/
├── controllers/      # Request handlers (REST endpoints)
├── services/         # Business logic
├── guards/           # Route protection
├── decorators/       # Custom parameter decorators
├── hfg-db.service.ts # Database connection service
├── hfg-cache.service.ts # Caching service
├── hfg-otp.service.ts  # OTP handling
├── hfg-results.service.ts # Results computation
├── hfg-importer.service.ts # Data import
├── hfg-certificate.service.ts # Certificate generation
├── hfg.config.ts     # Module configuration
├── hfg.util.ts       # Utility functions
├── hfg-jwt.util.ts   # JWT token handling
└── hyfitgames.module.ts # Main module definition
```

## Deployment

The module is deployed as part of the main NestJS application. No special deployment steps are required beyond standard application deployment.

### Environment-Specific Configuration
Some behaviors change based on `NODE_ENV`:

**Development:**
- Enhanced logging
- Debug endpoints enabled
- Universal OTP (654321) accepted for any number
- Less aggressive caching

**Production:**
- Optimized performance
- Security hardening
- Strict input validation
- Full audit logging
- Reduced debug information

### Scaling Considerations

#### Horizontal Scaling
- Multiple Node.js instances behind load balancer
- Shared Redis instance for session/cache data
- Shared PostgreSQL database
- Sticky sessions not required (stateless JWT)
- Consider database read replicas for heavy read loads

#### Vertical Scaling
- Increase application memory for larger connection pools
- Increase CPU for computational workloads (results calculation)
- Optimize database connection pool sizes
- Tune Redis memory allocation and persistence

#### Database Optimization
- Proper indexing on frequently queried columns
- Partitioning strategies for large tables (splits, results)
- Archive old event data to reduce table sizes
- Connection pool sizing based on concurrent user estimates
- Regular vacuum and analyze operations

#### Caching Strategy
- Redis memory allocation based on dataset size
- Appropriate TTL values for different data types
- Cache warming procedures for popular events
- Monitoring cache hit/miss ratios
- Considering Redis clustering for high availability

## API Documentation

Detailed API documentation is available through Swagger UI when the application runs with the Swagger module enabled:
```
http://localhost:3000/api-hfgswagger
```

Or view the generated OpenAPI specification:
```
http://localhost:3000/api-hfgswagger/json
```

## Security

### Authentication Security
- JWT access tokens with 15-minute expiration
- Refresh token rotation to prevent replay attacks
- HTTP-only, secure cookies for refresh token storage
- Rate limiting on authentication endpoints
- Password hashing with bcrypt (cost factor 10+)
- Account lockout after excessive failed attempts
- Secure password reset implementation

### Data Protection
- Parameterized queries to prevent SQL injection
- Input validation and sanitization on all endpoints
- Output encoding to prevent XSS in admin interfaces
- CSRF protection for state-changing operations
- File upload validation and virus scanning (if implemented)
- Secure headers (Helmet.js or equivalent)
- CORS policy restriction to trusted origins

### Privacy and Compliance
- GDPR-compliant data handling procedures
- Data export and deletion capabilities
- Consent tracking for marketing communications
- Data minimization principles applied
- Regular security audits and penetration testing
- Incident response plan and procedures

## Monitoring and Observability

### Health Checks
- `GET /hyfitgames/health` - Overall service health
- Individual checks for database, cache, and dependencies
- Resource utilization metrics (CPU, memory, disk)
- Dependency availability verification

### Logging
- Structured JSON logging for machine parsing
- Correlation IDs for request tracing
- Different log levels (debug, info, warn, error)
- Audit logging for security-relevant events
- Performance logging for slow queries and operations
- Error tracking with stack traces and context

### Metrics
- HTTP request duration histograms
- Database query performance metrics
- Cache hit/miss ratios
- Authentication success/failure rates
- Active user and session counts
- Business metrics (registrations, completions, etc.)
- Custom application metrics via Prometheus

### Alerting
- Error rate thresholds (>1% = warning, >5% = critical)
- Latency thresholds (p95 > 2s = warning, >5s = critical)
- Resource utilization (CPU/memory >85% = warning)
- Dependency availability (database/redis downtime)
- Business anomaly detection (sudden drops in activity)

## Troubleshooting

### Common Issues

#### Database Connection Problems
- **Symptoms**: 500 errors, database timeout messages
- **Checks**:
  1. Verify DATABASE_* environment variables
  2. Test connectivity with `psql` or similar client
  3. Check PostgreSQL server logs for connection errors
  4. Verify connection pool isn't exhausted
  5. Check for network/firewall issues

#### Cache Related Issues
- **Symptoms**: Stale data, cache miss storms, memory exhaustion
- **Checks**:
  1. Verify REDIS_* environment variables
  2. Test Redis connectivity with `redis-cli`
  3. Check Redis memory usage and eviction policies
  4. Review cache key naming and TTL values
  5. Monitor for cache stampedes on popular data

#### Authentication Failures
- **Symptoms**: Users unable to login, frequent token refresh loops
- **Checks**:
  1. Verify JWT secret consistency across instances
  2. Check system clock synchronization (NTP)
  3. Review token expiration and refresh logic
  4. Look for malformed or missing authorization headers
  5. Check rate limiting on auth endpoints

#### Performance Degradation
- **Symptoms**: Slow response times, timeouts under load
- **Checks**:
  1. Database query execution plans for missing indexes
  2. Connection pool saturation
  3. Resource bottlenecks (CPU, memory, disk I/O)
  4. Network latency between services
  5. Inefficient algorithms in business logic

### Debugging Tips
1. Enable debug logging in development:
   ```bash
   # In .env or environment
   LOG_LEVEL=debug
   ```

2. Use the built-in Swagger UI for API exploration:
   ```
   http://localhost:3000/api-hfgswagger
   ```

3. Check application startup logs for configuration issues
4. Monitor database connections with:
   ```sql
   SELECT * FROM pg_stat_activity WHERE datname = 'novarace';
   ```

5. Check Redis memory and key distribution:
   ```bash
   redis-cli info memory
   redis-cli --bigkeys
   ```

## License

This module is part of the Novarace platform and is subject to the same licensing terms.

## Support

For issues and questions regarding the HYFIT Games module:
1. Check the application logs for error details
2. Review this documentation and the code comments
3. Consult with platform administrators
4. Refer to the main Novarace documentation for platform-wide concerns

---
*Documentation generated: $(date)*
*Module version: 1.0.0*