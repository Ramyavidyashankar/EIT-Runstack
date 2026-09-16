#!/bin/bash

# Variables
smtpHost="relay.dxc.com"
mailFrom="rundeckautomation@dxc.com"
mailTo="dxcit-ore-appsinfra@dxc.com"
mailCc="kiran.sharma@dxc.com, ramyav@dxc.com"
subject="/var cleanup on $(hostname)"
log_path="/var/log"

# Get system hostname
SystemName=$(hostname)

# Check space before zipping logs
space_before_zipping=$(df -h /var)

echo "Space before zipping logs:"
echo "$space_before_zipping"

# Find files starting with 'message-' or 'secure-' but excluding 'messages', 'secure', and '*.gz'
found_files=$(find "$log_path" -type f \( -name 'messages-*' -o -name 'secure-*' \) ! -name 'messages' ! -name 'secure' ! -name '*.gz')

if [ -z "$found_files" ]; then
  echo "No files found matching the specified pattern."
else
  # Display the found files
  echo "Files found to zip:"
  echo "$found_files"

  # Zip the found files
  while IFS= read -r file; do
    /usr/bin/sudo gzip "$file"
  done <<< "$found_files"

  echo "Files have been zipped."

  # Check space after zipping logs
  space_after_zipping=$(df -h /var)

  echo "Space after zipping logs:"
  echo "$space_after_zipping"

  # Send email with the report
  body=" Hi Team,

  Please find the details.\n
  Space before Script execution:
  --------------------------------------------------------------------------------------------------\n
  $space_before_zipping\n\n
  Files found to zip:
  --------------------------------------------------------------------------------------------------\n
  $found_files\n
  --------------------------------------------------------------------------------------------------\n
  Space after Script execution:
  --------------------------------------------------------------------------------------------------\n
  $space_after_zipping\n

  This is an Email generated after script execution."

  echo -e "$body" | mail -s "$subject" -r "$mailFrom" -c "$mailCc" "$mailTo"
fi
