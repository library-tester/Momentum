# to do
x block size and count should be editable.
x checkboxes are reduntant, use just ids on your 
x display in day design: the image displayed should have black background not white one 
- collect better ascii graphics (big ones) and images (like your own ones)

# to do, designs and themes
- remove designs you dont like

# to do, optional
- remove very small and very big
- check the site on a smartphone and adjust as necessary
- find and analyze other peoples cmd like taskmanagers (like your own tkinter app)
- reduce the bload of commands and try to simplify them
- test the application extensively (look for bugs, anything annoying)
- get feedback by AI regarding the whole design and functionality
- download leads to save as instead of immediately downloading
- add a mode where you get a complete image every task
- learn git management


# to do, user management
- ask claude about user management, and ask for a prompt for claude code. the site should be usable for other users once it gets online, every user needs persistent data storage of this tasks and projects, the state of the task manager etc.

# ressources
- https://asciiart.website/browse.php
- https://www.asciiart.eu/ascii-art-dictionary?utm_source=chatgpt.com

# other project ideas
- the philosopher guide, webversion (desktop one coming later)


# personal mnemo
git status
git add .
or
git add README.md
git commit -m "Describe your changes"
git push

python3 -m http.server 8000

# if you add/remove/rename files in ascii_art/ or image_art/
# and want double-clicking momentum.html (no server) to see them:
python3 build_art_data.py

# done
x think of some shortcuts of commands, instead of display -d for example
x remove these visible points that show in yet to be seen ascii graphics
x instead of ascii graphics try it with images, revealing them part by part in a cubic way 
x add different themes
x scrolling bar in darkmode annoying, other color maybe
x on display: enter also leaves it as well as space, exits the fullscreen display
x make display also work with ascii graphics
x i want a much cleaner look of the list. to achieve this remove priority functionality completely, as well as project functionality, due functionality
x split view: "split on" / "split off" pins the task list in its own pane above the terminal
  on the left side, so the list is always visible. drag the divider between them to give the
  list more or less room; the position (and on/off) is saved with everything else.
x nicer list: framed with ─── rules above/below (sized to the content), dim rules + summary
  so the task titles are the only thing at full brightness and pop to the front
x [id] replaces the checkbox in list + archive, always visible and right-aligned so titles
  stay in a column. no checkbox needed: everything in the list is by definition not done yet,
  done ones are in the archive. active tasks get an [active] tag on the details line, which is
  the only thing the old [~] said that an id doesn't. (the interactive "remove" picker that
  briefly replaced this is gone again — remove/rm/delete all just take ids: 3 | 1,3,4 | 2-5 | all)
x id number left from checkbox, not below -> and only prints the second line (tags/priority/
  project/due) when there's actually something in it, so a plain task is one line, not two
x get it to work offline again -> generate art-data.js (python3 build_art_data.py) and have
  momentum.html load it via <script src> instead of fetch(); browsers block fetch()/XHR of
  local files under file://, but not <script src>/<img src> to local files, so this is the
  one case that genuinely can't be avoided rather than a bug — running the http server still
  works exactly as before and doesn't need this step, since fetch() works fine over http.
x remove anything to do with garden from this application and think maybe of another application title
x make it so images are displayed a little bigger so they better fit the screen. Especially vertical oriented images should almost fill the available space so they impress the viewer once they are fully revealed. 
x images should be placed and displayed from the top left corner as starting point, not in the middle of their frame
x add a command where you can see the image in full view (fullscreen, stretched to the outer border of the screen where escape and clicking on the image exits this view). the command can be called "display image" or think of a better command name.
x rm all removes all tasks
x get claude code to work
x remove the icon
x change the format to like in a splitscreen. the commandline is completely from top to bottom on the left side of the screen except the title area which stays on top. the garden or ascii graphic is on the right side of the screen.
x implement the image mode -> images should be stored as png files and if possible jpg jpeg png
x i want to be able to delete tasks by rm 1-4
x archive
x implement a nightmode where everything is red text and design elements on black background (switch nightmode)
x once an image or ascii graphic is finished add a small popup with the title "Image completed" with a download and close button. the download button enables the download of the image


