# Calendar API for sending meeting invitations

Bookings are created as events on the designated Write Calendar via its provider API (Google Calendar API, Microsoft Graph, Zoho Calendar API). The calendar provider then sends native meeting invitations to all attendees. This avoids building SMTP infrastructure or managing email deliverability.

We considered sending .ics attachments via email (requires SMTP, spam risk, deliverability issues) and a hybrid approach. Using the calendar API directly means zero email infrastructure, invitations come from a trusted source (Google/Microsoft/Zoho), and events automatically appear on the Admin's calendar.
