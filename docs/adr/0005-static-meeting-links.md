# Static meeting links instead of dynamic creation

Each Booking Profile stores a static meeting URL (a personal Teams room or Google Meet link). Every Booking on that profile uses the same link. We do not create unique meeting rooms per booking via the Teams/Meet APIs.

Dynamic link creation would require additional OAuth scopes, API integrations (Microsoft Graph for Teams meetings, Google Calendar conference data), error handling for meeting creation failures, and cleanup for cancelled meetings. A static personal room link achieves the same outcome — attendees join the same room at the scheduled time — with zero additional API complexity. The trade-off is that concurrent meetings on the same profile would share a link, but the scheduling system prevents this by design.
